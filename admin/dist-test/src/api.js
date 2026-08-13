/** Thin REST client for the admin PWA. */
async function requestJson(url, init) {
    const res = await fetch(url, init);
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.failures?.length) {
        throw new Error(body.error ?? `Request failed (${res.status})${body.failures?.length ? `: ${body.failures.length} asset operation(s) failed` : ''}`);
    }
    return body;
}
export async function fetchItems() {
    const res = await fetch('/api/thumbs');
    const json = (await res.json());
    return json.items;
}
export async function fetchCurrent() {
    const res = await fetch('/api/current');
    return (await res.json());
}
export async function fetchData() {
    return (await fetchCurrent()).data;
}
const STRING_PUBLIC_CONFIG_KEYS = new Set([
    'fillMode',
    'frameAspect',
    'transition',
    'motion',
    'playbackMediaMode',
    'smartFraming',
    'showQr',
    'screenRotation',
    'screenFlipHorizontal',
    'screenFlipVertical',
    'videoAudioMode',
    'videoMuted',
]);
let controlSocket = null;
function getControlSocket() {
    if (controlSocket && controlSocket.readyState <= WebSocket.OPEN)
        return controlSocket;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    try {
        const socket = new WebSocket(`${proto}://${location.host}/ws`);
        controlSocket = socket;
        socket.onerror = () => socket.close();
        socket.onclose = () => {
            if (controlSocket === socket)
                controlSocket = null;
        };
        return socket;
    }
    catch {
        controlSocket = null;
        return null;
    }
}
const CONTROL_SOCKET_TIMEOUT_MS = 1500;
function publicConfigMessage(patch) {
    const publicPatch = Object.fromEntries(Object.entries(patch).map(([key, value]) => {
        const numeric = Number(value);
        return [key, Number.isFinite(numeric) && !STRING_PUBLIC_CONFIG_KEYS.has(key) ? numeric : value];
    }));
    return JSON.stringify({ type: 'publicConfig', patch: publicPatch });
}
async function sendPublicConfig(patch) {
    const socket = getControlSocket();
    if (!socket)
        return false;
    const message = publicConfigMessage(patch);
    if (socket.readyState === WebSocket.OPEN) {
        try {
            socket.send(message);
            return true;
        }
        catch {
            socket.close();
            return false;
        }
    }
    if (socket.readyState !== WebSocket.CONNECTING)
        return false;
    return await new Promise((resolve) => {
        let settled = false;
        const finish = (sent) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            socket.removeEventListener('open', onOpen);
            socket.removeEventListener('error', onFailure);
            socket.removeEventListener('close', onFailure);
            resolve(sent);
        };
        const onOpen = () => {
            try {
                socket.send(message);
                finish(true);
            }
            catch {
                socket.close();
                finish(false);
            }
        };
        const onFailure = () => finish(false);
        const timeout = window.setTimeout(() => {
            socket.close();
            finish(false);
        }, CONTROL_SOCKET_TIMEOUT_MS);
        socket.addEventListener('open', onOpen, { once: true });
        socket.addEventListener('error', onFailure, { once: true });
        socket.addEventListener('close', onFailure, { once: true });
    });
}
export async function sendControl(message) {
    const socket = getControlSocket();
    if (!socket)
        return false;
    const payload = JSON.stringify(message);
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
        return true;
    }
    if (socket.readyState !== WebSocket.CONNECTING)
        return false;
    return await new Promise((resolve) => {
        const timeout = window.setTimeout(() => resolve(false), CONTROL_SOCKET_TIMEOUT_MS);
        socket.addEventListener('open', () => {
            window.clearTimeout(timeout);
            socket.send(payload);
            resolve(true);
        }, { once: true });
    });
}
export async function updateData(patch) {
    if ('videoAudioMode' in patch || 'videoMuted' in patch) {
        const typedPatch = { ...patch };
        if ('videoMuted' in typedPatch)
            typedPatch.videoMuted = typedPatch.videoMuted === 'true';
        if (await sendControl({ type: 'config', patch: typedPatch }))
            return;
    }
    else if (await sendPublicConfig(patch))
        return;
    const qs = new URLSearchParams(patch).toString();
    await fetch(`/api/data?${qs}`);
}
/**
 * Set the Google Photos retention window (days; 0 = keep forever).
 *
 * Deliberately bypasses `updateData()`: that helper tries the WebSocket `publicConfig`
 * channel first and resolves as soon as the message is *sent*, but the server drops any
 * patch containing a key outside its `PUBLIC_CONFIG_KEYS` allowlist — so this field would
 * be silently discarded and never fall through to REST.
 */
export async function setGooglePhotosRetentionDays(days) {
    await requestJson(`/api/data?googlePhotosRetentionDays=${encodeURIComponent(String(days))}`);
}
/**
 * Push a photo/clip to show on the frame right now. The server holds it in memory only —
 * it never joins the library or touches disk — and drops it when the TTL expires.
 */
export async function pushLiveCast(file, ttlSec) {
    const kind = file.type.startsWith('video/') ? 'video' : 'photo';
    const params = new URLSearchParams({ kind, mimeType: file.type || '' });
    if (ttlSec)
        params.set('ttlSec', String(ttlSec));
    const res = await fetch(`/api/live-cast?${params.toString()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
    });
    if (res.status === 413)
        throw new Error('That file is too large to live cast — try a shorter clip.');
    if (!res.ok)
        throw new Error(`Live cast failed (${res.status})`);
    return (await res.json());
}
/** Stop the active live cast so the frame resumes its slideshow immediately. */
export async function stopLiveCast() {
    await fetch('/api/live-cast/stop', { method: 'POST' });
}
export async function castItem(id) {
    await requestJson(`/api/cast/${id}`);
}
export async function deleteItem(id) {
    await requestJson(`/api/delete/${id}`);
}
export async function setItemsEnabled(ids, enabled) {
    await requestJson('/api/items/enabled', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids, enabled }),
    });
}
export async function deleteItems(ids) {
    await requestJson('/api/items', {
        method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }),
    });
}
export async function playSequence(ids) {
    await requestJson('/api/play-sequence', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }),
    });
}
export async function me() {
    const res = await fetch('/api/me');
    return (await res.json());
}
export async function login(password) {
    const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
    });
    return res.ok;
}
export async function logout() {
    await fetch('/api/logout', { method: 'POST' });
}
// These go through requestJson so a 401/500 rejects instead of resolving as success —
// otherwise a failed control silently does nothing and the UI looks like it worked.
export async function skipNext() { await requestJson('/api/next'); }
export async function skipPrev() { await requestJson('/api/previous'); }
export async function getPlayback() {
    return requestJson('/api/playback');
}
export async function setPaused(paused) {
    await requestJson(paused ? '/api/pause' : '/api/resume');
}
export async function setHold(holding) {
    await requestJson(holding ? '/api/hold' : '/api/unhold');
}
export async function seekBy(deltaSec) {
    await requestJson(`/api/seek?delta=${encodeURIComponent(deltaSec)}`);
}
/** Include/exclude an item from rotation; returns the new enabled state. */
export async function toggleEnabled(id) {
    const json = await requestJson(`/api/toggle/${id}`);
    return json.enabled;
}
export async function patchMediaTransforms(ids, transform) {
    const res = await fetch('/api/media/transforms', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids, transform }),
    });
    if (!res.ok)
        throw new Error((await res.json()).error ?? 'transform update failed');
    return (await res.json()).items;
}
// Upload in small chunks so large files pass proxies/CDNs that cap request body size
// (e.g. GitHub Codespaces returns 413 for big single requests).
const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB
/** A random, path-safe id that doesn't require a secure context (works over plain http). */
function uploadId() {
    return (Date.now().toString(36) +
        Math.random().toString(36).slice(2, 12) +
        Math.random().toString(36).slice(2, 12));
}
async function uploadFile(file, onProgress) {
    const id = uploadId();
    const total = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
    for (let i = 0; i < total; i++) {
        const chunk = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        const res = await fetch(`/api/upload/chunk?id=${id}`, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: chunk,
        });
        if (!res.ok)
            return { error: `upload failed at ${Math.round(((i + 1) / total) * 100)}% (${res.status})` };
        onProgress?.((i + 1) / total);
    }
    const res = await fetch(`/api/upload/finish?id=${id}&name=${encodeURIComponent(file.name)}&type=${encodeURIComponent(file.type)}`, { method: 'POST' });
    if (!res.ok)
        return { error: `finalize failed (${res.status})` };
    const json = (await res.json());
    return json.item ? { item: json.item } : { error: json.error ?? 'upload failed' };
}
export async function upload(files, onProgress) {
    const list = Array.from(files);
    const added = [];
    const errors = [];
    for (let f = 0; f < list.length; f++) {
        const result = await uploadFile(list[f], (p) => onProgress?.((f + p) / list.length));
        if (result.item)
            added.push(result.item);
        else
            errors.push({ filename: list[f].name, error: result.error ?? 'upload failed' });
    }
    return { ok: errors.length === 0, added, errors };
}
export async function googleStatus() {
    const res = await fetch('/api/google/status');
    return (await res.json());
}
/** Create a Google Photos Picker session (returns the URI the user opens to pick). */
export async function createPickerSession() {
    const res = await fetch('/api/google/picker/session', { method: 'POST' });
    if (!res.ok)
        throw new Error('failed to create picker session');
    return (await res.json());
}
/** Poll a Picker session to see whether the user has finished selecting. */
export async function pollPickerSession(id) {
    const res = await fetch(`/api/google/picker/session/${encodeURIComponent(id)}`);
    if (!res.ok)
        throw new Error('failed to poll picker session');
    return (await res.json());
}
/** Import the items the user picked in a session. Returns how many were added. */
export async function importPickerSession(id) {
    const res = await fetch(`/api/google/picker/session/${encodeURIComponent(id)}/import`, { method: 'POST' });
    if (!res.ok)
        throw new Error('failed to import picked items');
    const json = (await res.json());
    return json.imported;
}
export function thumbUrl(item) {
    return `/photos/${item.thumb}`;
}
//# sourceMappingURL=api.js.map