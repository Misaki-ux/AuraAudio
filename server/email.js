// Email delivery for passwordless sign-in codes.
// Uses the Resend HTTP API; credentials stay in environment variables.

class EmailService {
    constructor(env = process.env) {
        this.apiKey = env.AURA_EMAIL_API_KEY || '';
        this.from = env.AURA_EMAIL_FROM || '';
        this.apiUrl = env.AURA_EMAIL_API_URL || 'https://api.resend.com/emails';
    }

    isConfigured() {
        return !!(this.apiKey && this.from);
    }

    async sendSignInPin(email, pin) {
        if (!this.isConfigured()) throw new Error('Email sign-in is not configured on this server.');
        const response = await fetch(this.apiUrl, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: this.from,
                to: [email],
                subject: 'Your AuraAudio sign-in code',
                text: `Your AuraAudio sign-in code is ${pin}. It expires in 10 minutes. If you did not request this code, you can ignore this email.`,
                html: `<p>Your AuraAudio sign-in code is:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">${pin}</p><p>It expires in 10 minutes. If you did not request this code, you can ignore this email.</p>`
            })
        });
        if (!response.ok) {
            const detail = (await response.text()).slice(0, 300);
            throw new Error(`Email provider rejected the message (${response.status}): ${detail}`);
        }
    }
}

module.exports = EmailService;
