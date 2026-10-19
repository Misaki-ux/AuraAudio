// =========================================================================
// AuraAudio Authentication & OAuth 2.0 Engine (server/auth.js)
// Standalone JWT Engine (HMAC-SHA256) & Multi-Provider OAuth 2.0 Integration
// =========================================================================

const crypto = require('crypto');

class AuthService {
    constructor(config, db, emailService = null) {
        this.config = config.server;
        this.oauthConfig = config.oauth || {};
        this.db = db;
        this.emailService = emailService;
        this.secret = this.config.jwtSecret || 'aura_default_secret_key_change_me';
        this.emailChallenges = new Map();
        this.emailRequestTimes = new Map();
        this.emailIpRequests = new Map();
    }

    normalizeEmail(email) {
        return typeof email === 'string' ? email.trim().toLowerCase() : '';
    }

    async requestEmailPin(email, username, clientAddress = 'unknown') {
        const normalizedEmail = this.normalizeEmail(email);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
            throw Object.assign(new Error('Enter a valid email address.'), { statusCode: 400 });
        }
        if (!this.emailService || !this.emailService.isConfigured()) {
            throw Object.assign(new Error('Email sign-in is not configured. Set AURA_EMAIL_API_KEY and AURA_EMAIL_FROM on the server.'), { statusCode: 503 });
        }

        const now = Date.now();
        for (const [address, requestedAt] of this.emailRequestTimes) {
            if (now - requestedAt > 10 * 60_000) this.emailRequestTimes.delete(address);
        }
        for (const [address, challenge] of this.emailChallenges) {
            if (now > challenge.expiresAt) this.emailChallenges.delete(address);
        }
        for (const [address, requests] of this.emailIpRequests) {
            const recent = requests.filter(time => now - time < 10 * 60_000);
            if (recent.length) this.emailIpRequests.set(address, recent);
            else this.emailIpRequests.delete(address);
        }
        const lastEmailRequest = this.emailRequestTimes.get(normalizedEmail) || 0;
        if (now - lastEmailRequest < 60_000) {
            return { success: true, message: 'If the address can sign in, a code will arrive shortly.' };
        }
        const ipRequests = (this.emailIpRequests.get(clientAddress) || []).filter(time => now - time < 10 * 60_000);
        if (ipRequests.length >= 6) {
            throw Object.assign(new Error('Too many code requests. Try again in a few minutes.'), { statusCode: 429 });
        }
        ipRequests.push(now);
        this.emailIpRequests.set(clientAddress, ipRequests);
        this.emailRequestTimes.set(normalizedEmail, now);

        const pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
        const digest = crypto.createHmac('sha256', this.secret)
            .update(`${normalizedEmail}:${pin}`)
            .digest('hex');
        this.emailChallenges.set(normalizedEmail, {
            digest,
            expiresAt: now + 10 * 60_000,
            attempts: 0,
            username: typeof username === 'string' ? username.trim().slice(0, 40) : ''
        });

        try {
            await this.emailService.sendSignInPin(normalizedEmail, pin);
        } catch (error) {
            this.emailChallenges.delete(normalizedEmail);
            throw Object.assign(new Error('Could not send the sign-in email. Check the server mail settings and try again.'), { statusCode: 502 });
        }
        return { success: true, message: 'If the address can sign in, a code will arrive shortly.' };
    }

    verifyEmailPin(email, pin) {
        const normalizedEmail = this.normalizeEmail(email);
        const challenge = this.emailChallenges.get(normalizedEmail);
        if (!challenge || Date.now() > challenge.expiresAt || challenge.attempts >= 5) {
            this.emailChallenges.delete(normalizedEmail);
            throw Object.assign(new Error('Invalid or expired sign-in code.'), { statusCode: 400 });
        }
        challenge.attempts += 1;
        const submittedDigest = crypto.createHmac('sha256', this.secret)
            .update(`${normalizedEmail}:${String(pin || '')}`)
            .digest();
        const expectedDigest = Buffer.from(challenge.digest, 'hex');
        if (submittedDigest.length !== expectedDigest.length || !crypto.timingSafeEqual(submittedDigest, expectedDigest)) {
            if (challenge.attempts >= 5) this.emailChallenges.delete(normalizedEmail);
            throw Object.assign(new Error('Invalid or expired sign-in code.'), { statusCode: 400 });
        }
        this.emailChallenges.delete(normalizedEmail);

        let user = this.db.findUserByEmail(normalizedEmail);
        if (!user) {
            const requested = challenge.username || normalizedEmail.split('@')[0];
            const base = requested.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 32) || 'AuraUser';
            let username = base;
            while (this.db.findUserByUsername(username)) {
                username = `${base.slice(0, 25)}_${crypto.randomBytes(3).toString('hex')}`;
            }
            user = this.db.createUser({ username, email: normalizedEmail, provider: 'email' });
        }
        const token = this.createToken({ userId: user.id, username: user.username, email: user.email });
        return {
            token,
            user: { id: user.id, username: user.username, email: user.email, avatarUrl: user.avatarUrl, provider: user.provider }
        };
    }

    // --- Password Security ---
    hashPassword(password) {
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
        return `${salt}:${hash}`;
    }

    verifyPassword(password, storedHash) {
        if (!storedHash || !storedHash.includes(':')) return false;
        const [salt, key] = storedHash.split(':');
        const derived = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
        return key === derived;
    }

    // --- Pure Native JWT Generator (Zero Dependencies) ---
    base64UrlEncode(str) {
        return Buffer.from(str)
            .toString('base64')
            .replace(/=/g, '')
            .replace(/\+/g, '-')
            .replace(/\//g, '_');
    }

    base64UrlDecode(str) {
        let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4) base64 += '=';
        return Buffer.from(base64, 'base64').toString('utf8');
    }

    createToken(payload) {
        const header = { alg: 'HS256', typ: 'JWT' };
        const now = Math.floor(Date.now() / 1000);
        const expiry = now + (this.config.tokenExpiryHours || 72) * 3600;

        const body = Object.assign({}, payload, {
            iat: now,
            exp: expiry,
            iss: 'AuraAudio-Server'
        });

        const encodedHeader = this.base64UrlEncode(JSON.stringify(header));
        const encodedPayload = this.base64UrlEncode(JSON.stringify(body));
        const signature = crypto
            .createHmac('sha256', this.secret)
            .update(`${encodedHeader}.${encodedPayload}`)
            .digest('base64')
            .replace(/=/g, '')
            .replace(/\+/g, '-')
            .replace(/\//g, '_');

        return `${encodedHeader}.${encodedPayload}.${signature}`;
    }

    verifyToken(token) {
        if (!token || typeof token !== 'string') return null;
        const parts = token.split('.');
        if (parts.length !== 3) return null;

        const [encodedHeader, encodedPayload, signature] = parts;
        const expectedSignature = crypto
            .createHmac('sha256', this.secret)
            .update(`${encodedHeader}.${encodedPayload}`)
            .digest('base64')
            .replace(/=/g, '')
            .replace(/\+/g, '-')
            .replace(/\//g, '_');

        if (signature !== expectedSignature) return null;

        try {
            const payload = JSON.parse(this.base64UrlDecode(encodedPayload));
            const now = Math.floor(Date.now() / 1000);
            if (payload.exp && payload.exp < now) {
                return null; // Expired
            }
            return payload;
        } catch {
            return null;
        }
    }

    // --- Local Auth Handlers ---
    register(username, email, password) {
        if (!username || username.trim().length < 2) {
            throw new Error('Username must be at least 2 characters.');
        }
        if (!email || !email.includes('@')) {
            throw new Error('Valid email address is required.');
        }
        if (!password || password.length < 6) {
            throw new Error('Password must be at least 6 characters.');
        }

        if (this.db.findUserByEmail(email)) {
            throw new Error('A user with this email already exists.');
        }
        if (this.db.findUserByUsername(username)) {
            throw new Error('This username is already taken.');
        }

        const passwordHash = this.hashPassword(password);
        const user = this.db.createUser({
            username: username.trim(),
            email: email.trim().toLowerCase(),
            passwordHash,
            provider: 'local'
        });

        const token = this.createToken({ userId: user.id, username: user.username, email: user.email });
        return {
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                avatarUrl: user.avatarUrl,
                provider: user.provider
            }
        };
    }

    login(identifier, password) {
        if (!identifier || !password) {
            throw new Error('Username/Email and password are required.');
        }

        const user = this.db.findUserByEmail(identifier) || this.db.findUserByUsername(identifier);
        if (!user || !user.passwordHash) {
            throw new Error('Invalid credentials.');
        }

        if (!this.verifyPassword(password, user.passwordHash)) {
            throw new Error('Invalid credentials.');
        }

        const token = this.createToken({ userId: user.id, username: user.username, email: user.email });
        return {
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                avatarUrl: user.avatarUrl,
                provider: user.provider
            }
        };
    }

    // --- OAuth 2.0 Engine & Provider Config for UI ---
    getPublicOAuthConfig() {
        const publicProviders = {};
        for (const [key, p] of Object.entries(this.oauthConfig)) {
            publicProviders[key] = {
                id: key,
                name: p.name,
                icon: p.icon,
                enabled: !!p.enabled,
                clientId: p.clientId,
                authUrl: p.authUrl,
                redirectUri: p.redirectUri,
                scope: p.scope
            };
        }
        return publicProviders;
    }

    getOAuthRedirectUrl(provider) {
        const p = this.oauthConfig[provider];
        if (!p || !p.enabled) {
            throw new Error(`OAuth provider '${provider}' is not supported or disabled.`);
        }

        const state = crypto.randomBytes(16).toString('hex');
        const url = new URL(p.authUrl);
        url.searchParams.set('client_id', p.clientId);
        url.searchParams.set('redirect_uri', p.redirectUri);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('scope', p.scope);
        url.searchParams.set('state', state);

        return {
            provider,
            authUrl: url.toString(),
            state
        };
    }

    // Handle OAuth Callback / Dev Testing Simulation
    handleOAuthCallback(provider, code, state, mockProfile = null) {
        const p = this.oauthConfig[provider];
        if (!p) throw new Error(`Unknown OAuth provider: ${provider}`);

        // In real deployment with active secrets, would exchange code for accessToken.
        // For local development and out-of-the-box UI responsiveness:
        const profile = mockProfile || {
            username: `${p.name}User_${crypto.randomBytes(3).toString('hex')}`,
            email: `${provider}_user_${Date.now()}@aura.local`,
            providerId: `oauth_${provider}_${crypto.randomBytes(6).toString('hex')}`
        };

        let user = this.db.findUserByEmail(profile.email);
        if (!user) {
            user = this.db.createUser({
                username: profile.username,
                email: profile.email,
                avatarUrl: `https://api.dicebear.com/7.x/identicon/svg?seed=${profile.username}`,
                provider,
                providerId: profile.providerId
            });
        }

        const token = this.createToken({ userId: user.id, username: user.username, email: user.email });
        return {
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                avatarUrl: user.avatarUrl,
                provider: user.provider
            }
        };
    }
}

module.exports = AuthService;
