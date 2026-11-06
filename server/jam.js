const crypto = require('crypto');

const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_MEMBERS = 20;
const MAX_QUEUE = 100;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode() {
    return [...crypto.randomBytes(8)].map(byte => CODE_ALPHABET[byte & 31]).join('');
}

function cleanText(value, maxLength) {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function cleanTrack(track) {
    if (!track || typeof track !== 'object' || Array.isArray(track)) return null;
    const title = cleanText(track.title || track.name, 200);
    if (!title) return null;
    return {
        id: cleanText(track.id, 100),
        title,
        artist: cleanText(track.artist, 160),
        cover: typeof track.cover === 'string' && track.cover.length <= 1200 ? track.cover : '',
        streamUrl: typeof track.streamUrl === 'string'
            && /^\/api\/media\/[A-Za-z0-9._%()-]+$/.test(track.streamUrl)
            ? track.streamUrl : '',
        sourceUrl: typeof track.sourceUrl === 'string'
            && /^https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(track.sourceUrl)
            ? track.sourceUrl.slice(0, 500) : '',
        playQuery: cleanText(track.playQuery, 400)
    };
}

class JamService {
    constructor() {
        this.room = null;
        this.tokens = new Map();
    }

    prune() {
        if (this.room && Date.now() - this.room.updatedAt > ROOM_TTL_MS) {
            this.room = null;
            this.tokens.clear();
        }
    }

    create(ownerName = 'Host') {
        this.prune();
        this.room = {
            code: randomCode(),
            ownerToken: crypto.randomBytes(32).toString('hex'),
            ownerName: cleanText(ownerName, 32) || 'Host',
            members: [],
            queue: [],
            playback: { track: null, playing: false, currentTime: 0, updatedAt: Date.now() },
            updatedAt: Date.now()
        };
        this.tokens.clear();
        this.tokens.set(this.room.ownerToken, { role: 'owner', name: this.room.ownerName });
        return { code: this.room.code, token: this.room.ownerToken, role: 'owner' };
    }

    join(code, name = 'Guest') {
        this.prune();
        if (!this.room || cleanText(code, 16).toUpperCase() !== this.room.code) {
            throw new Error('That Jam code is invalid or the room has ended.');
        }
        if (this.room.members.length >= MAX_MEMBERS) throw new Error('This Jam already has the maximum number of guests.');
        const memberName = cleanText(name, 32) || 'Guest';
        const token = crypto.randomBytes(32).toString('hex');
        const memberId = crypto.randomBytes(8).toString('hex');
        this.room.members.push({ id: memberId, name: memberName });
        this.tokens.set(token, { role: 'guest', name: memberName, memberId });
        this.room.updatedAt = Date.now();
        return { token, role: 'guest', name: memberName };
    }

    get(token) {
        this.prune();
        const member = this.tokens.get(token);
        if (!this.room || !member) throw new Error('You are no longer connected to a Jam.');
        return {
            role: member.role,
            name: member.name,
            code: this.room.code,
            members: [this.room.ownerName, ...this.room.members.map(item => item.name)],
            playback: this.room.playback,
            queue: this.room.queue.map(item => ({ ...item }))
        };
    }

    publish(token, payload = {}) {
        this.prune();
        const member = this.tokens.get(token);
        if (!this.room || member?.role !== 'owner') throw new Error('Only the Jam host can control playback.');
        const currentTime = Number(payload.currentTime);
        this.room.playback = {
            track: cleanTrack(payload.track),
            playing: payload.playing === true,
            currentTime: Number.isFinite(currentTime) ? Math.max(0, Math.min(currentTime, 24 * 60 * 60)) : 0,
            updatedAt: Date.now()
        };
        this.room.updatedAt = Date.now();
        return { updated: true };
    }

    requestTrack(token, payload = {}) {
        this.prune();
        const member = this.tokens.get(token);
        if (!this.room || member?.role !== 'guest') throw new Error('Join a Jam as a guest to request tracks.');
        if (this.room.queue.length >= MAX_QUEUE) throw new Error('The Jam request queue is full.');
        const track = cleanTrack(payload.track);
        if (!track) throw new Error('A track title is required.');
        const query = cleanText(payload.query, 400) || track.playQuery || track.sourceUrl || `${track.title} ${track.artist}`.trim();
        const request = {
            id: crypto.randomBytes(8).toString('hex'),
            track: { ...track, streamUrl: '' },
            query,
            requestedBy: member.name,
            createdAt: Date.now()
        };
        this.room.queue.push(request);
        this.room.updatedAt = Date.now();
        return { queued: true, request };
    }

    consumeRequest(token, requestId) {
        this.prune();
        const member = this.tokens.get(token);
        if (!this.room || member?.role !== 'owner') throw new Error('Only the Jam host can manage requests.');
        const index = this.room.queue.findIndex(item => item.id === requestId);
        if (index < 0) throw new Error('That Jam request is no longer available.');
        this.room.updatedAt = Date.now();
        return this.room.queue.splice(index, 1)[0];
    }

    leave(token) {
        this.prune();
        const member = this.tokens.get(token);
        if (!this.room || !member) return false;
        if (member.role === 'owner') {
            this.room = null;
            this.tokens.clear();
            return true;
        }
        this.tokens.delete(token);
        this.room.members = this.room.members.filter(item => item.id !== member.memberId);
        this.room.updatedAt = Date.now();
        return true;
    }
}

module.exports = JamService;
