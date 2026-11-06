const net = require('net');

function normalizeIp(value) {
    let ip = String(value || '').trim().replace(/^\[|\]$/g, '');
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    return ip;
}

function isPrivateIp(value) {
    const ip = normalizeIp(value);
    if (net.isIP(ip) === 4) {
        const [a, b] = ip.split('.').map(Number);
        return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168) || (a === 169 && b === 254);
    }
    if (net.isIP(ip) === 6) {
        const normalized = ip.toLowerCase();
        return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')
            || normalized.startsWith('fe8') || normalized.startsWith('fe9')
            || normalized.startsWith('fea') || normalized.startsWith('feb');
    }
    return false;
}

function clientIp(req) {
    const peer = normalizeIp(req.socket?.remoteAddress);
    if ((peer === '127.0.0.1' || peer === '::1') && req.headers['x-forwarded-for']) {
        const forwarded = String(req.headers['x-forwarded-for']).split(',').map(normalizeIp);
        return forwarded.find(Boolean) || peer;
    }
    return peer;
}

function isLanRequest(req) {
    return isPrivateIp(clientIp(req));
}

module.exports = { clientIp, isLanRequest, isPrivateIp, normalizeIp };
