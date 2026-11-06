(() => {
  'use strict';
  const DB_NAME = 'AuraAutonomousClient';
  const DB_VERSION = 2;
  const STORE = 'records';
  const QUEUE = 'actions';
  const AUDIO = 'audio';
  const $ = selector => document.querySelector(selector);
  const localAssets = location.hostname === 'localhost' && location.pathname === '/';
  const assetRoot = localAssets ? './assets/' : '/assets/';
  document.querySelectorAll('[data-asset]').forEach(image => { image.src = assetRoot + image.dataset.asset; });
  const protectedImageUrls = new Map();
  const downloadJobs = new Set();
  const serverJobIds = new Set();
  const content = $('#content');
  const message = $('#message');
  const serverInput = $('#serverUrl');
  const state = { liked: [], likedArtists: [], catalog: [], discovery: [], mixes: [], discoveryOffset: 8, discoveryHasMore: false, playlists: [], downloads: [], listeningHistory: [], activeView: 'discover', syncing: false, queue: [], current: -1, shuffle: false, repeat: 'off', lyricLines: 1 };
  let downloadsRenderGeneration=0,lastArtistImageRefresh=0;
  const serverKey = 'aura_autonomous_server';
  const pairedTokenKey = 'aura_autonomous_paired_token';
  const jwtKey = 'aura_jwt';
  const nativeApp = Boolean(window.Capacitor?.isNativePlatform?.());
  const nativeStorage = nativeApp ? window.Capacitor?.Plugins?.LocalStorage : null;
  let dbPromise;

  async function nativeCall(method, options = {}) {
    if (!nativeStorage || typeof nativeStorage[method] !== 'function') {
      throw new Error('Secure on-device storage is unavailable. Update or reinstall the autonomous app.');
    }
    return nativeStorage[method](options);
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(QUEUE)) db.createObjectStore(QUEUE, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(AUDIO)) db.createObjectStore(AUDIO, { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }

  async function deleteIndexedDbDatabase() {
    if(dbPromise){(await dbPromise).close();dbPromise=null}
    await new Promise((resolve,reject)=>{
      const request=indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess=()=>resolve();
      request.onerror=()=>reject(request.error||new Error('Could not reset legacy browser storage.'));
      request.onblocked=()=>reject(new Error('Close other AuraAudio tabs before resetting browser storage.'));
    });
  }

  function indexedDbAudio(key) { return openDb().then(db=>new Promise((resolve,reject)=>{const r=db.transaction(AUDIO).objectStore(AUDIO).get(key);r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>reject(r.error);})); }
  function indexedDbAllAudio() { return openDb().then(db=>new Promise((resolve,reject)=>{const r=db.transaction(AUDIO).objectStore(AUDIO).getAll();r.onsuccess=()=>resolve(r.result||[]);r.onerror=()=>reject(r.error);})); }
  function indexedDbDeleteAudio(key) { return openDb().then(db=>new Promise((resolve,reject)=>{const tx=db.transaction(AUDIO,'readwrite');tx.objectStore(AUDIO).delete(key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);})); }
  async function audioId(key) {
    const bytes = new TextEncoder().encode(key);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return [...digest].map(value=>value.toString(16).padStart(2,'0')).join('');
  }
  async function readAudio(key) {
    if(!nativeApp){const row=await indexedDbAudio(key);return row?.blob||null}
    const id=await audioId(key),listing=await nativeCall('listAudio'),file=(listing.files||[]).find(item=>item.id===id);
    if(!file)return null;
    const parts=[];
    for(let offset=0;offset<file.size;){
      const chunk=await nativeCall('readAudioChunk',{id,offset,length:Math.min(192*1024,file.size-offset)});
      const raw=atob(chunk.data),bytes=new Uint8Array(raw.length);
      for(let index=0;index<raw.length;index++)bytes[index]=raw.charCodeAt(index);
      parts.push(bytes);offset=chunk.nextOffset;
      if(!chunk.eof&&chunk.nextOffset<=chunk.offset)throw new Error('On-device audio read did not advance.');
    }
    return new Blob(parts,{type:file.mimeType||'application/octet-stream'});
  }
  async function writeAudio(key, track, blob) {
    if(!nativeApp){const db=await openDb();return new Promise((resolve,reject)=>{const tx=db.transaction(AUDIO,'readwrite');tx.objectStore(AUDIO).put({key,track,blob,savedAt:Date.now()});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}
    if(!(blob instanceof Blob)||!blob.size)throw new Error('Cannot save an empty audio file.');
    const id=await audioId(key);
    const metadataKey=`audio-meta:${id}`,previousMetadata=await readRecord(metadataKey);
    await writeRecord(metadataKey,{key,track,savedAt:Date.now()});
    let writeStarted=false;
    try{
      await nativeCall('beginAudioWrite',{id,mimeType:blob.type||'application/octet-stream',expectedSize:blob.size});
      writeStarted=true;
      for(let offset=0;offset<blob.size;offset+=192*1024){
        const bytes=new Uint8Array(await blob.slice(offset,offset+192*1024).arrayBuffer());
        let binary='';
        for(let index=0;index<bytes.length;index+=0x8000)binary+=String.fromCharCode(...bytes.subarray(index,Math.min(index+0x8000,bytes.length)));
        await nativeCall('appendAudioChunk',{id,data:btoa(binary)});
      }
      await nativeCall('finishAudioWrite',{id});
    }catch(error){
      const cleanup=[];
      if(writeStarted)try{await nativeCall('cancelAudioWrite',{id})}catch(cleanupError){cleanup.push(cleanupError.message)}
      try{if(previousMetadata===null)await nativeCall('deleteRecord',{key:metadataKey});else await writeRecord(metadataKey,previousMetadata)}catch(cleanupError){cleanup.push(cleanupError.message)}
      if(cleanup.length)throw new Error(`${error.message} Storage cleanup also failed: ${cleanup.join('; ')}`);
      throw error;
    }
  }
  async function allAudio() {
    if(!nativeApp)return indexedDbAllAudio();
    const [listing,records]=await Promise.all([nativeCall('listAudio'),nativeCall('getAllRecords')]);
    return (listing.files||[]).map(file=>{
      const metadata=JSON.parse(records.records?.[`audio-meta:${file.id}`]||'{}');
      return{key:metadata.key||file.id,track:metadata.track||{title:'Saved audio'},savedAt:metadata.savedAt||file.updatedAt,size:file.size,mimeType:file.mimeType};
    });
  }
  async function deleteAudio(key) {
    if(!nativeApp)return indexedDbDeleteAudio(key);
    const id=await audioId(key);
    await nativeCall('deleteAudio',{id});
    await nativeCall('deleteRecord',{key:`audio-meta:${id}`});
  }

  async function readRecord(key) {
    if(nativeApp){const record=await nativeCall('getRecord',{key});return record.found?JSON.parse(record.value):null}
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result?.value ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  async function writeRecord(key, value) {
    if(nativeApp){await nativeCall('setRecord',{key,value:JSON.stringify(value)});return}
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ key, value });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function listActions() {
    if(nativeApp){const result=await nativeCall('getActions');return(result.actions||[]).map(action=>{try{return JSON.parse(action.payload)}catch{return null}}).filter(Boolean)}
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const request = db.transaction(QUEUE).objectStore(QUEUE).getAll();
      request.onsuccess = () => resolve((request.result || []).sort((a, b) => a.createdAt - b.createdAt));
      request.onerror = () => reject(request.error);
    });
  }

  async function putAction(action) {
    if(nativeApp){await nativeCall('putAction',{id:action.id,payload:JSON.stringify(action),createdAt:action.createdAt});return}
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(QUEUE, 'readwrite');
      tx.objectStore(QUEUE).put(action);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function deleteActions(ids) {
    if (!ids.length) return;
    if(nativeApp){for(const id of ids)await nativeCall('deleteAction',{id});return}
    const db = await openDb();
  }

  async function migrateLegacyIndexedDb() {
    if(!nativeApp)return;
    if(await readRecord('migration-idb-v1'))return;
    const db=await openDb();
    const [records,actions,audio]=await Promise.all([
      new Promise((resolve,reject)=>{const request=db.transaction(STORE).objectStore(STORE).getAll();request.onsuccess=()=>resolve(request.result||[]);request.onerror=()=>reject(request.error)}),
      new Promise((resolve,reject)=>{const request=db.transaction(QUEUE).objectStore(QUEUE).getAll();request.onsuccess=()=>resolve(request.result||[]);request.onerror=()=>reject(request.error)}),
      indexedDbAllAudio()
    ]);
    const savedRecords=await nativeCall('getAllRecords'),savedActions=await nativeCall('getActions'),savedAudio=await nativeCall('listAudio');
    const recordKeys=new Set(Object.keys(savedRecords.records||{})),actionIds=new Set((savedActions.actions||[]).map(item=>item.id)),audioIds=new Set((savedAudio.files||[]).map(item=>item.id));
    for(const row of records)if(!recordKeys.has(row.key))await writeRecord(row.key,row.value);
    for(const action of actions)if(!actionIds.has(action.id))await putAction(action);
    for(const row of audio){
      const id=await audioId(row.key);
      if(!audioIds.has(id))await writeAudio(row.key,row.track,row.blob);
      else if(!(await readRecord(`audio-meta:${id}`)))await writeRecord(`audio-meta:${id}`,{key:row.key,track:row.track,savedAt:row.savedAt||Date.now()});
    }
    const verifiedRecords=await nativeCall('getAllRecords'),verifiedActions=await nativeCall('getActions'),verifiedAudio=await nativeCall('listAudio');
    const verifiedRecordKeys=new Set(Object.keys(verifiedRecords.records||{})),verifiedActionIds=new Set((verifiedActions.actions||[]).map(item=>item.id)),verifiedAudioIds=new Set((verifiedAudio.files||[]).map(item=>item.id));
    if(records.some(row=>!verifiedRecordKeys.has(row.key))||actions.some(row=>!verifiedActionIds.has(row.id))||await Promise.all(audio.map(async row=>{const id=await audioId(row.key);return!verifiedAudioIds.has(id)||!(await readRecord(`audio-meta:${id}`))})).then(results=>results.some(Boolean)))throw new Error('Could not verify the legacy library migration; the original local data was kept.');
    await new Promise((resolve,reject)=>{const tx=db.transaction([STORE,QUEUE,AUDIO],'readwrite');tx.objectStore(STORE).clear();tx.objectStore(QUEUE).clear();tx.objectStore(AUDIO).clear();tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)});
    await writeRecord('migration-idb-v1',{completedAt:new Date().toISOString(),records:records.length,actions:actions.length,audio:audio.length});
    return new Promise((resolve, reject) => {
      const tx = db.transaction(QUEUE, 'readwrite');
      const store = tx.objectStore(QUEUE);
      ids.forEach(id => store.delete(id));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  function baseUrl() {
    if (nativeApp) return '';
    return (localStorage.getItem(serverKey) || (location.hostname === 'localhost' ? '' : location.origin)).trim().replace(/\/+$/, '');
  }

  function localApi(path, options = {}) {
    const requestUrl = new URL(path, 'https://aura.local');
    const method = String(options.method || 'GET').toUpperCase();
    const body = options.body ? JSON.parse(options.body) : {};
    const pathname = requestUrl.pathname;
    const save = async () => { await saveState(); return { success: true }; };

    if (method === 'GET' && pathname === '/api/status') {
      return Promise.resolve({ status: 'online', app: 'AuraAudio on-device library', version: '1.0', storage: 'app-private' });
    }
    if (method === 'GET' && pathname === '/api/library/liked') return Promise.resolve(state.liked);
    if (method === 'GET' && pathname === '/api/library/artists/liked') return Promise.resolve(state.likedArtists);
    if (method === 'GET' && pathname === '/api/library/playlists') return Promise.resolve(state.playlists);
    if (method === 'GET' && pathname === '/api/library/downloads') {
      return allAudio().then(items => items.map(item => ({
        ...item.track,
        title: item.track?.title || item.track?.name || 'Untitled track',
        deviceAudioKey: item.key,
        downloadedLocal: true
      })));
    }
    if (method === 'GET' && pathname === '/api/library/transfer/export') {
      return Promise.resolve(exportLocalLibrary());
    }
    if (method === 'POST' && pathname === '/api/library/liked/import') {
      state.liked=mergeTracks(state.liked,body.tracks||[]);
      return save().then(()=>({imported:body.tracks?.length||0,likedSongs:state.liked}));
    }
    if (method === 'POST' && pathname === '/api/library/played') {
      const track=body.track||{};
      if(track.title||track.name)state.listeningHistory=[{title:track.title||track.name,artist:track.artist||'',playedAt:new Date().toISOString()},...state.listeningHistory].slice(0,5000);
      return save().then(()=>({success:true}));
    }
    if (method === 'POST' && pathname === '/api/mobile/sync') {
      return Promise.resolve({ accepted: (body.actions || []).map(action => action.id), likedSongs: state.liked, likedArtists: state.likedArtists });
    }
    if (method === 'POST' && pathname === '/api/library/artists/toggle') {
      const artist = body.artist || {};
      const key = artistKey(artist);
      if (!key || !artist.name) return Promise.reject(new Error('Artist name is required.'));
      state.likedArtists = isLikedArtist(artist)
        ? state.likedArtists.filter(item => artistKey(item) !== key)
        : [...state.likedArtists.filter(item => artistKey(item) !== key), artist];
      return save().then(() => artist);
    }
    if (method === 'POST' && pathname === '/api/library/playlists') {
      const name = String(body.name || '').trim().slice(0, 100);
      if (!name) return Promise.reject(new Error('Playlist name is required.'));
      const playlist = { id: crypto.randomUUID ? crypto.randomUUID() : `local-${Date.now()}`, name, tracks: [], createdAt: new Date().toISOString() };
      state.playlists = [playlist, ...state.playlists];
      return save().then(() => playlist);
    }
    const playlistMatch=pathname.match(/^\/api\/library\/playlists\/([^/]+)$/);
    if(playlistMatch&&['PUT','PATCH','DELETE'].includes(method)){
      const playlistId=decodeURIComponent(playlistMatch[1]),index=state.playlists.findIndex(item=>String(item.id)===playlistId);
      if(index<0)return Promise.reject(new Error('Playlist was not found on this device.'));
      if(method==='DELETE'){state.playlists.splice(index,1);return save().then(()=>({success:true}))}
      const name=String(body.name||'').trim().slice(0,100);
      if(!name)return Promise.reject(new Error('Playlist name is required.'));
      state.playlists[index]={...state.playlists[index],...body,name};
      return save().then(()=>state.playlists[index]);
    }
    const playlistTrackMatch = pathname.match(/^\/api\/library\/playlists\/([^/]+)\/tracks$/);
    if (method === 'POST' && playlistTrackMatch) {
      const playlistId = decodeURIComponent(playlistTrackMatch[1]);
      const playlist = state.playlists.find(item => String(item.id) === playlistId);
      if (!playlist) return Promise.reject(new Error('Playlist was not found on this device.'));
      playlist.tracks = [...(playlist.tracks || []), body.track].filter(Boolean);
      return save().then(() => playlist);
    }
    if (method === 'GET' && pathname === '/api/search') {
      const query = requestUrl.searchParams.get('q') || '';
      const tracks = offlineSearch(query);
      const artists = state.likedArtists.filter(artist => String(artist.name || '').toLocaleLowerCase().includes(query.toLocaleLowerCase()));
      return Promise.resolve({ tracks, library: tracks, artists, youtube: [] });
    }
    if (method === 'GET' && pathname === '/api/artists/songs') {
      const artist = requestUrl.searchParams.get('artist') || '';
      return Promise.resolve(mergeTracks(state.catalog, state.liked).filter(track => String(track.artist || '').toLocaleLowerCase() === artist.toLocaleLowerCase()));
    }
    if (method === 'GET' && pathname === '/api/discovery/daily-mix') return Promise.resolve({ mixes: state.mixes, hasMore: false });
    if (method === 'GET' && pathname === '/api/discovery/releases') return Promise.resolve({ releases: [] });
    if (method === 'GET' && pathname.startsWith('/api/discovery/latest-releases')) return Promise.resolve({ releases: [] });
    if (method === 'GET' && pathname === '/api/telemetry') return Promise.resolve({ totals: { plays: state.listeningHistory.length, likes: state.liked.length, downloads: state.downloads.length, playlists: state.playlists.length, diagnostics: 0 }, topArtists: [] });
    if(method==='GET'&&pathname==='/api/telemetry/preferences')return readRecord('play-history-preferences').then(saved=>saved||{retentionDays:0,minimumListenSeconds:0});
    if(method==='PUT'&&pathname==='/api/telemetry/preferences'){
      const saved={retentionDays:Number(body.retentionDays)||0,minimumListenSeconds:Number(body.minimumListenSeconds)||0};
      return writeRecord('play-history-preferences',saved).then(()=>saved);
    }
    return Promise.reject(new Error('This feature needs the optional AuraAudio desktop server. Your on-device library remains available.'));
  }

  function apiHeaders(json = false) {
    const headers = {};
    if (json) headers['Content-Type'] = 'application/json';
    const key = localStorage.getItem(pairedTokenKey) || '';
    const token = localStorage.getItem(jwtKey) || '';
    if (key) headers['X-Aura-Access-Key'] = key;
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  async function api(path, options = {}) {
    if (nativeApp) return localApi(path, options);
    const response = await fetch(`${baseUrl()}${path}`, {
      ...options,
      headers: { ...apiHeaders(Boolean(options.body)), ...(options.headers || {}) },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload.message || payload.error || `Server returned ${response.status}`;
      if (response.status === 401) {
        try { $('#connectionPanel').hidden = false; $('#connectionToggle').setAttribute('aria-expanded', 'true'); } catch {}
        showMessage('This phone is not paired with the server. Scan a new Pair mobile QR from the server or its autonomous-client launcher.', true);
      }
      throw new Error(message);
    }
    return payload;
  }

  async function queueServerDownloads(tracks) {
    const candidates = (tracks || []).filter(track => track && (track.title || track.name));
    if (!candidates.length) throw new Error('No downloadable tracks are available.');
    const result = await api('/api/ytb/batch', {
      method: 'POST',
      body: JSON.stringify({ tracks: candidates.map(track => ({
        title: track.title || track.name || '',
        artist: track.artist || '',
        url: track.sourceUrl || track.playQuery || track.url || ''
      })) })
    });
    const failed = (result.jobs || []).filter(job => job.status === 'failed').length;
    showMessage(`${result.queued || 0} server download${result.queued === 1 ? '' : 's'} queued in the background${failed ? `; ${failed} could not be queued` : ''}. Playback and device storage were not changed.`, failed > 0);
  }

  const jamStorageKey = 'aura_autonomous_jam_session';
  let jamSession = null;
  let jamTimer = null;
  let jamPolling = false;
  let lastJamTrackId = '';
  async function jamApi(path, options = {}) {
    return api(path, {
      ...options,
      headers: { ...(options.headers || {}), 'X-Aura-Jam-Token': jamSession?.token || '' }
    });
  }
  function currentJamTrack() {
    const track = state.queue[state.current];
    if (!track) return null;
    const mediaUrl = track.streamUrl || track.url || '';
    let mediaPath = mediaUrl;
    try { mediaPath = new URL(mediaUrl, baseUrl() || location.origin).pathname; } catch {}
    return {
      id: String(track.id || track.fileName || trackKey(track)),
      title: track.title || track.name || '',
      artist: track.artist || '',
      cover: track.cover || track.image || '',
      streamUrl: /^\/api\/media\/[A-Za-z0-9._%()-]+$/.test(mediaPath) ? mediaPath : '',
      sourceUrl: track.sourceUrl || track.youtubeUrl || '',
      playQuery: track.playQuery || ''
    };
  }
  async function applyJamPlayback(playback) {
    const shared = playback?.track;
    if (!shared || !shared.title || shared.id === lastJamTrackId) {
      const audio = $('#audio');
      if (shared && Number.isFinite(playback.currentTime) && Number.isFinite(audio.duration)
        && Math.abs(audio.currentTime - playback.currentTime) > 4) audio.currentTime = playback.currentTime;
      if (playback?.playing && audio.paused) await audio.play().catch(error => showMessage(`Jam playback could not start: ${error.message}`, true));
      else if (playback && !playback.playing && !audio.paused) audio.pause();
      return;
    }
    lastJamTrackId = shared.id;
    const source = {
      ...shared,
      sourceUrl: shared.sourceUrl || shared.playQuery || '',
      playQuery: shared.playQuery || shared.sourceUrl || ''
    };
    const track = { ...source, id: shared.id, title: shared.title, artist: shared.artist, streamUrl: shared.streamUrl || '' };
    await playTrack(track, [track]);
    if (!playback.playing) $('#audio').pause();
    else if (Number.isFinite(playback.currentTime)) $('#audio').currentTime = playback.currentTime;
  }
  async function pollJam() {
    if (!jamSession || jamPolling) return;
    jamPolling = true;
    try {
      const session = await jamApi('/api/jam/session');
      if (session.role === 'owner') {
        await jamApi('/api/jam/playback', {
          method: 'PUT',
          body: JSON.stringify({ track: currentJamTrack(), playing: !$('#audio').paused, currentTime: $('#audio').currentTime || 0 })
        });
        for (const request of session.queue || []) {
          await jamApi(`/api/jam/queue/${encodeURIComponent(request.id)}`, { method: 'DELETE' });
          const query = request.query || `${request.track.title} ${request.track.artist}`.trim();
          state.queue.push({ ...request.track, id: `jam_request_${request.id}`, sourceUrl: query, playQuery: query });
          renderQueue();
          showMessage(`${request.requestedBy} requested “${request.track.title}”; added to your queue.`);
        }
      } else await applyJamPlayback(session.playback);
      $('#jamBtn').title = `${session.role === 'owner' ? 'Hosting' : 'Joined'} Jam ${session.code} · ${session.members.length} members`;
    } catch (error) {
      jamSession = null;
      sessionStorage.removeItem(jamStorageKey);
      clearInterval(jamTimer);
      jamTimer = null;
      showMessage(`Jam connection lost: ${error.message}`, true);
    } finally { jamPolling = false; }
  }
  async function useJam(track = null) {
    if (jamSession) {
      if (track) {
        if (jamSession.role === 'guest') {
          await jamApi('/api/jam/queue', {
            method: 'POST',
            body: JSON.stringify({ track: { title: track.title || track.name, artist: track.artist || '' }, query: track.sourceUrl || track.playQuery || `${track.title || track.name} ${track.artist || ''}`.trim() })
          });
          showMessage(`Requested “${track.title || track.name}” from the Jam host.`);
        } else {
          state.queue.push(track);
          renderQueue();
          showMessage(`Added “${track.title || track.name}” to your queue without interrupting playback.`);
        }
        return;
      }
      if (confirm(`End Jam ${jamSession.code}?`)) {
        await jamApi('/api/jam/session', { method: 'DELETE' });
        jamSession = null;
        sessionStorage.removeItem(jamStorageKey);
        clearInterval(jamTimer);
        jamTimer = null;
        $('#jamBtn').title = 'Make or join a Wi-Fi Jam';
      }
      return;
    }
    const code = prompt('Enter a Jam code to join, or leave blank to create a Jam:') || '';
    const result = await api(code.trim() ? '/api/jam/join' : '/api/jam/session', {
      method: 'POST',
      body: JSON.stringify(code.trim() ? { code: code.trim(), name: 'AuraAudio guest' } : { name: 'AuraAudio host' })
    });
    jamSession = { token: result.token, role: result.role, code: result.code || code.trim() };
    sessionStorage.setItem(jamStorageKey, JSON.stringify(jamSession));
    jamTimer = setInterval(() => void pollJam(), 2000);
    if (jamSession.role === 'owner') {
      await jamApi('/api/jam/playback', {
        method: 'PUT',
        body: JSON.stringify({ track: currentJamTrack(), playing: !$('#audio').paused, currentTime: $('#audio').currentTime || 0 })
      });
      alert(`Jam ${jamSession.code} is ready. Friends on this Wi-Fi can enter this code.`);
      if (track) await useJam(track);
    } else if (track) await useJam(track);
    await pollJam();
  }

  async function setImageSource(image, source) {
    if (!source) return;
    const value=String(source);
    let needsAuth=false;
    try { const parsed=new URL(value,baseUrl()||location.origin); needsAuth=parsed.pathname.startsWith('/api/covers/'); } catch {}
    if (!needsAuth) { image.src=value.startsWith('/api/') ? `${baseUrl()}${value}` : value; return; }
    const absolute=value.startsWith('http')?value:`${baseUrl()}${value}`;
    if(protectedImageUrls.has(absolute)){image.src=protectedImageUrls.get(absolute);return;}
    try{const response=await fetch(absolute,{headers:apiHeaders(),cache:'force-cache',signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error(`Cover request returned ${response.status}`);const blob=await response.blob();const objectUrl=URL.createObjectURL(blob);protectedImageUrls.set(absolute,objectUrl);image.src=objectUrl;}catch(error){console.warn('[Autonomous mobile] Could not load protected artwork:',error.message);image.removeAttribute('src');}
  }

  function trackKey(track) {
    const normalize=value=>String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
    const artist=normalize(track.artist).replace(/^(unknown artist|youtube audio|unknown)$/, '');
    return `${normalize(track.title || track.name)}|${artist}`;
  }

  function mergeTracks(...collections) {
    const map = new Map();
    for (const track of collections.flat()) {
      if (!track || !(track.title || track.name)) continue;
      const key = trackKey(track);
      const current = map.get(key) || {};
      map.set(key, { ...current, ...track, title: track.title || track.name || current.title, artist: track.artist || current.artist || '' });
    }
    return [...map.values()];
  }

  function showMessage(text, error = false) {
    message.textContent = text;
    message.style.color = error ? '#ff8799' : '#ffda55';
  }

  function applyTheme(color){document.documentElement.style.setProperty('--accent',color);document.documentElement.style.setProperty('--accent-soft',`${color}33`);const meta=document.querySelector('meta[name="theme-color"]');if(meta)meta.content=color;const match=String(color).match(/^#([\da-f]{6})$/i);if(match){const n=parseInt(match[1],16),r=n>>16,g=(n>>8)&255,b=n&255,max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min;let hue=0;if(delta){if(max===r)hue=((g-b)/delta)%6;else if(max===g)hue=(b-r)/delta+2;else hue=(r-g)/delta+4;hue=Math.round(hue*60);if(hue<0)hue+=360}const icon=$('#appBrandIcon');if(icon)icon.style.filter=`hue-rotate(${hue-225}deg) saturate(1.3) drop-shadow(0 0 5px ${color}99)`;const favicon=document.querySelector('link[rel="icon"]');if(favicon&&icon?.complete){try{const canvas=document.createElement('canvas');canvas.width=canvas.height=128;const ctx=canvas.getContext('2d');ctx.filter=`hue-rotate(${hue-225}deg) saturate(1.3)`;ctx.drawImage(icon,0,0,128,128);favicon.href=canvas.toDataURL('image/png')}catch{}}}}

  function setOnlineStatus() {
    const online = navigator.onLine;
    $('#netDot').classList.toggle('on', online);
    $('#netText').textContent = online ? 'Network available' : 'Offline mode';
  }

  async function saveState() {
    await writeRecord('client-state', {
      liked: state.liked,
      likedArtists: state.likedArtists,
      catalog: state.catalog.slice(-700),
      discovery: state.discovery.slice(0, 60),
      playlists: state.playlists,
      mixes: state.mixes.slice(0, 60),
      listeningHistory: state.listeningHistory.slice(0, 5000)
    });
  }

  function exportLocalLibrary() {
    const cleanTrack = track => ({
      title: String(track.title || track.name || '').slice(0, 240),
      artist: String(track.artist || '').slice(0, 180),
      album: String(track.album || track.albumTitle || '').slice(0, 240),
      duration: Number(track.duration) || 0,
      addedAt: track.addedAt || ''
    });
    return {
      format: 'AuraAudio-library-transfer',
      version: 1,
      exportedAt: new Date().toISOString(),
      likedSongs: state.liked.slice(0, 1000).map(cleanTrack).filter(track => track.title),
      likedArtists: state.likedArtists.slice(0, 500).map(artist => ({
        id: String(artist.id || artist.key || '').slice(0, 180),
        name: String(artist.name || artist.title || '').slice(0, 180),
        likedAt: artist.likedAt || ''
      })).filter(artist => artist.name),
      listeningHistory: [],
      playlists: state.playlists.slice(0, 100).map(playlist => ({
        name: String(playlist.name || 'Untitled playlist').slice(0, 100),
        description: String(playlist.description || '').slice(0, 240),
        createdAt: playlist.createdAt || '',
        tracks: (playlist.tracks || []).slice(0, 200).map(cleanTrack).filter(track => track.title)
      })),
      listeningHistory: state.listeningHistory.slice(0, 5000).map(item=>({...cleanTrack(item),playedAt:item.playedAt})).filter(item=>item.title&&item.playedAt),
      downloadMetadata: state.downloads.slice(0, 1000).map(item => ({...cleanTrack(item.track || item),downloadedAt:item.savedAt?new Date(item.savedAt).toISOString():''})).filter(track => track.title)
    };
  }

  async function loadSavedState() {
    const saved = await readRecord('client-state');
    if (!saved) return;
    state.liked = Array.isArray(saved.liked) ? saved.liked : [];
    state.likedArtists = Array.isArray(saved.likedArtists) ? saved.likedArtists : [];
    state.catalog = Array.isArray(saved.catalog) ? saved.catalog : [];
    state.discovery = Array.isArray(saved.discovery) ? saved.discovery : [];
    state.playlists = Array.isArray(saved.playlists) ? saved.playlists : [];
    state.mixes = Array.isArray(saved.mixes) ? saved.mixes : [];
    state.listeningHistory = Array.isArray(saved.listeningHistory) ? saved.listeningHistory : [];
  }

  function isLiked(track) {
    const key = trackKey(track);
    return state.liked.some(item => trackKey(item) === key);
  }

  function escText(element, text) { element.textContent = String(text || ''); return element; }

  function renderTracks(title, tracks, mix = null) {
    const heading = document.createElement('h2');
    heading.className = 'content-heading';
    heading.textContent = `${title} · ${tracks.length}`;
    content.append(heading);
    const list = document.createElement('div');
    list.className = 'list';
    for (const track of tracks) {
      const row = document.createElement('article');
      row.className = 'row';
      const number = document.createElement('div');
      number.className = 'track-num';
      number.textContent = String(list.children.length + 1);
      const art = document.createElement('div');
      art.className = 'track-art';
      if (track.cover || track.image) {
        const image = document.createElement('img');
        void setImageSource(image, track.cover || track.image);
        image.alt = '';
        image.loading = 'lazy';
        image.onerror = () => { image.remove(); art.textContent = '♫'; };
        art.append(image);
      } else art.textContent = '♫';
      const info = document.createElement('div');
      info.className = 'info';
      const name = document.createElement('div');
      name.className = 'name';
      escText(name, track.title || track.name || 'Untitled track');
      const artist = document.createElement('div');
      artist.className = 'sub';
      escText(artist, track.artist || 'Unknown artist');
      if(track.artist){artist.tabIndex=0;artist.role='button';artist.title='Open artist page';artist.addEventListener('click',()=>openArtist(track.artist,track));}
      if(track.album||track.albumTitle){name.title='Open album';name.tabIndex=0;name.addEventListener('click',()=>openAlbum(track.album||track.albumTitle,[track],track.artist||''));}
      const albumName=track.album||track.albumTitle;
      if(albumName||(track.artist&&!/^(?:unknown artist|youtube(?: audio)?)$/i.test(track.artist))){const album=document.createElement('button');album.type='button';album.className='album-link';album.textContent=albumName||'Find album & artwork';album.setAttribute('aria-label',`Open album information for ${track.title||track.name||'track'}`);album.addEventListener('click',()=>void openAlbum(albumName||'', [track],track.artist||track.channel||track.uploader||''));info.append(album)}
      info.append(name, artist);
      const playButton = document.createElement('button');
      playButton.type='button'; playButton.className='row-play'; playButton.textContent='▶'; playButton.setAttribute('aria-label',`Play ${track.title||track.name||'track'}`); playButton.addEventListener('click',()=>playTrack(track,tracks));
      const download = document.createElement('button'); download.type='button'; download.className='row-download';
      if(track.downloadedLocal||track.deviceAudioKey){download.textContent='⌫';download.title='Remove audio from this device';download.setAttribute('aria-label',`Remove downloaded audio for ${track.title||track.name||'track'}`);download.addEventListener('click',async()=>{try{await deleteAudio(track.deviceAudioKey||trackKey(track));state.downloads=await allAudio();showMessage('Downloaded audio removed from this device.');render()}catch(error){showMessage(`Could not remove downloaded audio: ${error.message}`,true)}})}
      else if(track.serverDownload&&track.fileName){download.textContent='⌫';download.title='Delete server download';download.setAttribute('aria-label',`Delete server download ${track.title||track.name||'track'}`);download.addEventListener('click',async()=>{if(!confirm(`Delete ${track.title||track.fileName} from the server?`))return;try{await api('/api/library/downloads',{method:'DELETE',body:JSON.stringify({fileName:track.fileName})});showMessage('Server download deleted.');if(state.activeView==='downloads')await renderLocalDownloads();else await loadLibrary()}catch(error){showMessage(`Could not delete server download: ${error.message}`,true)}})}
      else if(nativeApp){download.textContent='⬇';download.disabled=true;download.title='Online downloads need the optional server. Import audio files in Settings.';download.setAttribute('aria-label','Online downloads are unavailable in standalone mode')}
      else{download.textContent='⬇';download.title='Save audio on this device';download.setAttribute('aria-label',`Download ${track.title||track.name||'track'} to this device`);download.addEventListener('click',()=>void downloadTrack(track))}
      const likeButton = document.createElement('button');
      likeButton.type = 'button'; likeButton.className = `heart${isLiked(track) ? ' liked' : ''}`;
      likeButton.textContent = isLiked(track) ? '♥' : '♡';
      likeButton.setAttribute('aria-pressed', String(isLiked(track)));
      likeButton.setAttribute('aria-label', `${isLiked(track) ? 'Unlike' : 'Like'} ${track.title || track.name || 'track'}`);
      likeButton.addEventListener('click', () => toggleTrack(track));
      row.append(number, art, info, playButton, likeButton, download);
      if(mix){row.classList.add('mix-track');const locked=isMixTrackLocked(mix,track);const lock=document.createElement('button');lock.type='button';lock.className=`mix-lock${locked?' locked':''}`;lock.textContent=locked?'🔒':'🔓';lock.title=locked?'Keep this song when refreshing this mix':'Lock this song in the mix';lock.setAttribute('aria-pressed',String(locked));lock.onclick=event=>{event.stopPropagation();setMixTrackLocked(mix,track,!isMixTrackLocked(mix,track));renderMixTracks(mix)};row.append(lock)}
      const more=document.createElement('button');more.type='button';more.className='track-more';more.textContent='⋮';more.title='More track options';more.setAttribute('aria-label',`More options for ${track.title||track.name||'track'}`);more.onclick=event=>{event.stopPropagation();void openTrackActions(track).then(()=>appendTrackActions(track))};row.append(more);
      list.append(row);
    }
    content.append(list);
  }

  function addSectionTitle(title){const h=document.createElement('h2');h.className='content-heading';h.textContent=title;content.append(h)}
  async function loadLibrary(){
    if(nativeApp){
      try{
        state.downloads=await allAudio();
        await saveState();
        render();
        showMessage('Your library is stored on this device. A desktop server is optional for QR sync.');
      }catch(error){showMessage(`Could not load the on-device library: ${error.message}`,true)}
      return;
    }
    if(!navigator.onLine){render();showMessage('Offline: showing music stored on this device.');return}
    showMessage('Loading your server library…');
    const results=await Promise.allSettled([api('/api/library/liked'),api('/api/library/artists/liked'),api('/api/library/playlists'),api('/api/library/downloads')]);
    const failures=results.filter(x=>x.status==='rejected');
    if(results[0].status==='fulfilled')state.liked=mergeTracks(results[0].value||[]);
    if(results[1].status==='fulfilled')state.likedArtists=Array.isArray(results[1].value)?results[1].value:[];
    if(results[2].status==='fulfilled')state.playlists=Array.isArray(results[2].value)?results[2].value:[];
    if(results[3].status==='fulfilled')state.serverDownloads=Array.isArray(results[3].value)?results[3].value:[];
    state.downloads=await allAudio().catch(()=>[]);await saveState();render();
    void refreshLikedArtistImages();
    showMessage(failures.length?`Some library data could not load: ${failures.map(x=>x.reason?.message||'request failed').join('; ')}`:'Library loaded from your server and this device.',failures.length>0);
  }
  function openArtist(name, initial={}){const overlay=$('#detailOverlay'),body=$('#detailContent');body.replaceChildren();overlay.hidden=false;const hero=document.createElement('div');hero.className='detail-hero';const image=document.createElement('img');image.alt='';image.onerror=()=>image.remove();if(initial.image)void setImageSource(image,initial.image);const title=document.createElement('h1');title.textContent=name;const summary=document.createElement('p');summary.textContent=initial.description||'Loading artist profile…';hero.append(image,title,summary);body.append(hero);const songsSection=document.createElement('div');songsSection.className='detail-section';songsSection.textContent='Loading artist songs…';body.append(songsSection);
    Promise.allSettled([api(`/api/artists/songs?artist=${encodeURIComponent(name)}`),api(`/api/artists/profile?name=${encodeURIComponent(name)}`),api(`/api/discovery/latest-releases?artist=${encodeURIComponent(name)}`)]).then(([songsResult,profileResult,releasesResult])=>{
      const songs=songsResult.status==='fulfilled'&&Array.isArray(songsResult.value)?mergeTracks(songsResult.value):[];const profile=profileResult.status==='fulfilled'?profileResult.value:null;const artistImage=profile?.image||profile?.cover||profile?.artwork||initial.image||'';if(artistImage){void setImageSource(image,artistImage);const likedIndex=state.likedArtists.findIndex(item=>artistKey(item)===artistKey(initial)||String(item.name||'').toLocaleLowerCase()===String(name).toLocaleLowerCase());if(likedIndex>=0){state.likedArtists[likedIndex]={...state.likedArtists[likedIndex],image:artistImage};void saveState();if(state.activeView==='liked')render()}}if(profile?.description||profile?.bio)summary.textContent=profile.description||profile.bio;
      songsSection.replaceChildren();const bar=document.createElement('div');bar.className='overlay-actions';const play=document.createElement('button');play.textContent='▶ Play songs';play.onclick=()=>{overlay.hidden=true;playTrack(songs[0],songs)};const queue=document.createElement('button');queue.textContent='☷ Queue songs';queue.onclick=()=>{state.queue=songs;renderQueue();$('#queuePanel').hidden=false;};const favorite=document.createElement('button');favorite.textContent=isLikedArtist(initial)?'♥ Liked':'♡ Like artist';favorite.onclick=async()=>{await toggleLikedArtist({...initial,name,image:profile?.image||initial.image||''});favorite.textContent=isLikedArtist({...initial,name})?'♥ Liked':'♡ Like artist'};bar.append(play,queue,favorite);body.insertBefore(bar,songsSection);
      const releases=releasesResult.status==='fulfilled'?(releasesResult.value?.releases||releasesResult.value?.items||[]):[];if(releases.length){const h=document.createElement('h2');h.textContent='Latest releases';songsSection.append(h);for(const release of releases){const p=document.createElement('p');p.className='detail-row';p.textContent=`${release.title||release.name||'Release'}${release.date?` · ${release.date}`:''}`;songsSection.append(p)}}
      const albums=new Map();songs.forEach(t=>{const a=t.album||t.albumTitle;if(a){if(!albums.has(a))albums.set(a,[]);albums.get(a).push(t)}});if(albums.size){const h=document.createElement('h2');h.textContent='Albums';songsSection.append(h);for(const [album,tracks] of albums){const b=document.createElement('button');b.className='queue-item';b.textContent=`▤ ${album} · ${tracks.length} tracks`;b.onclick=()=>openAlbum(album,tracks,name);songsSection.append(b)}}
      const h=document.createElement('h2');h.textContent=`Songs · ${songs.length}`;songsSection.append(h);if(!songs.length){const empty=document.createElement('p');empty.textContent=songsResult.status==='rejected'?`Songs could not be loaded: ${songsResult.reason.message}`:'No artist songs were found.';songsSection.append(empty)}else songs.forEach(t=>{const b=document.createElement('button');b.className='queue-item';b.textContent=`▶ ${t.title||t.name} · ${t.artist||name}`;b.onclick=()=>{overlay.hidden=true;playTrack(t,songs)};songsSection.append(b)});
    });
  }
  async function openAlbum(name, tracks=[], artist=''){const overlay=$('#detailOverlay'),body=$('#detailContent');body.replaceChildren();overlay.hidden=false;let albumName=name||tracks[0]?.album||tracks[0]?.albumTitle||'',cover=tracks[0]?.cover||tracks[0]?.image||'';const hero=document.createElement('div');hero.className='detail-hero';const image=document.createElement('img');image.alt='Album artwork';image.onerror=()=>image.remove();const h=document.createElement('h1');h.textContent=albumName||'Album';const sub=document.createElement('p');sub.textContent=artist;hero.append(image,h,sub);body.append(hero);const actions=document.createElement('div');actions.className='overlay-actions';const play=document.createElement('button');play.textContent='▶ Play album';play.onclick=()=>{overlay.hidden=true;playTrack(tracks[0],tracks)};const queue=document.createElement('button');queue.textContent='☷ Add to queue';queue.onclick=()=>{state.queue=tracks;state.current=0;renderQueue();$('#queuePanel').hidden=false};actions.append(play,queue);body.append(actions);let all=tracks;
    const cleanArtist=/^(unknown artist|youtube(?: audio)?|unknown)$/i.test(String(artist||''))?'':artist;
    const cleanTrackTitle=value=>String(value||'').replace(/[[(](?:[^)\]]*(?:official|video|lyrics?|audio|explicit|remaster(?:ed)?|international\s+version|radio\s+edit|single\s+version)[^)]*)[)\]]/gi,' ').replace(/\s+/g,' ').trim();
    if(tracks[0]&&(!albumName||!cover))try{const meta=await api(`/api/music/track-metadata?title=${encodeURIComponent(cleanTrackTitle(tracks[0].title||tracks[0].name||''))}&artist=${encodeURIComponent(cleanArtist)}`);albumName=albumName||meta.album||'';cover=cover||meta.cover||meta.artwork||meta.image||'';h.textContent=albumName||'Album';if(meta.artist)sub.textContent=meta.artist}catch(error){showMessage(`Track metadata lookup unavailable: ${error.message}`,true)}
    if(albumName)try{const response=await api(`/api/albums?name=${encodeURIComponent(albumName)}&title=${encodeURIComponent(albumName)}&artist=${encodeURIComponent(cleanArtist)}`);if(Array.isArray(response.tracks)&&response.tracks.length)all=mergeTracks(response.tracks,tracks);cover=response.cover||response.artwork||response.image||cover;sub.textContent=response.artist||cleanArtist||''}catch(error){showMessage(`Album metadata unavailable: ${error.message}`,true)}
    if(cover)void setImageSource(image,cover);const title=document.createElement('h2');title.textContent=`Tracks · ${all.length}`;body.append(title);all.forEach(t=>{const row=document.createElement('button');row.className='queue-item';row.textContent=`▶ ${t.title||t.name}`;row.onclick=()=>{overlay.hidden=true;playTrack(t,all)};body.append(row)});}

  function renderEmpty(text) {
    const box = document.createElement('div');
    box.className = 'empty-state';
    box.textContent = text;
    content.append(box);
  }

  function render() {
    content.replaceChildren();
    const pending = listActions().then(actions => {
      $('#syncStatus').textContent = actions.length ? `${actions.length} change${actions.length === 1 ? '' : 's'} waiting to sync.` : 'Your library is stored on this device.';
    }).catch(error => {showMessage(`Could not read saved changes: ${error.message}`,true)});
    if (state.activeView === 'liked') {
      renderLikedArtists();
      if (state.liked.length) renderTracks('Liked on this device', state.liked);
      else if(!state.likedArtists.length) renderEmpty('No liked songs or artists saved yet. Search while online, or like songs from cached discovery.');
    } else if (state.activeView === 'search') {
      if (state.searchResults?.length) renderTracks(state.searchOnline ? 'Tracks' : 'Cached tracks', state.searchResults);
      if(state.searchYoutube?.length)renderTracks('YouTube',state.searchYoutube);
      if(state.searchArtists?.length){addSectionTitle(`Artists · ${state.searchArtists.length}`);state.searchArtists.forEach(a=>{const b=document.createElement('button');b.className='queue-item';b.textContent=`♫ ${a.name}${a.genre?` · ${a.genre}`:''}`;b.onclick=()=>openArtist(a.name,a);content.append(b)})}
      if (!state.searchResults?.length&&!state.searchArtists?.length&&!state.searchYoutube?.length) renderEmpty('Search the server while online. Offline search includes music you have already found or liked on this device.');
    } else if(state.activeView==='library') {
      const libraryTracks=mergeTracks(state.liked,state.serverDownloads||[],state.downloads.map(x=>x.track),state.catalog);
      addSectionTitle(`Your library · ${libraryTracks.length} tracks`);
      const transferEntry=document.createElement('section');transferEntry.className='library-transfer-entry';
      const transferCopy=document.createElement('span');
      const transferTitle=document.createElement('strong');transferTitle.textContent='Move your library to desktop';
      const transferNote=document.createElement('small');transferNote.textContent='One-use QR · library records only · audio stays on this phone.';
      transferCopy.append(transferTitle,transferNote);
      const transferButton=document.createElement('button');transferButton.type='button';transferButton.dataset.libraryTransfer='';transferButton.textContent='Transfer by QR';
      transferEntry.append(transferCopy,transferButton);content.append(transferEntry);
      renderLikedArtists();
      if(libraryTracks.length)renderTracks('Tracks',libraryTracks);else renderEmpty('No tracks are saved in this server library yet.');
      if(state.playlists.length){addSectionTitle(`Playlists · ${state.playlists.length}`);state.playlists.forEach(p=>{const b=document.createElement('button');b.className='queue-item';b.textContent=`▤ ${p.name} · ${(p.tracks||[]).length} tracks`;b.onclick=()=>openPlaylist(p);content.append(b)})}
    } else if(state.activeView==='playlists') {
      const h=document.createElement('h2');h.className='content-heading';h.textContent=`Playlists · ${state.playlists.length}`;content.append(h);
      const create=document.createElement('button');create.className='sync';create.textContent='＋ Create playlist';create.onclick=async()=>{const name=prompt('Playlist name');if(!name?.trim())return;try{const p=await api('/api/library/playlists',{method:'POST',body:JSON.stringify({name:name.trim()})});state.playlists.unshift(p);render();}catch(e){showMessage(e.message,true)}};content.append(create);
      const grid=document.createElement('div');grid.className='autonomous-mix-grid';
      state.playlists.forEach(playlist=>{
        const tracks=playlist.tracks||[],card=document.createElement('article');card.className='autonomous-mix-card';
        const art=document.createElement('div');art.className='autonomous-mix-art';
        const covers=tracks.map(track=>track.cover||track.image||track.thumbnail||'').filter(Boolean).slice(0,4);
        if(covers.length)covers.forEach(source=>{const image=document.createElement('img');image.alt='';image.loading='lazy';void setImageSource(image,source);art.append(image)});
        else{const icon=document.createElement('span');icon.textContent='♫';art.append(icon)}
        const copy=document.createElement('div');copy.className='autonomous-mix-copy';
        const label=document.createElement('small');label.textContent='PLAYLIST';
        const name=document.createElement('strong');name.textContent=playlist.name||'Untitled playlist';
        const count=document.createElement('span');count.textContent=`${tracks.length} tracks`;
        copy.append(label,name,count);
        const open=document.createElement('button');open.type='button';open.className='sync';open.textContent='Open tracks';open.onclick=()=>openPlaylist(playlist);
        const download=document.createElement('button');download.type='button';download.className='sync';download.textContent=nativeApp?'Online downloads need server':'⬇ Save on server';download.disabled=nativeApp||!tracks.length;download.onclick=()=>void queueServerDownloads(tracks).catch(error=>showMessage(error.message,true));
        card.append(art,copy,open,download);grid.append(card);
      });
      content.append(grid);
    } else if(state.activeView==='downloads') {
      void renderLocalDownloads().catch(error=>{content.replaceChildren();renderEmpty(`On-device audio is unavailable: ${error.message}`);showMessage(`Could not load device audio: ${error.message}`,true)});
    } else if(state.activeView==='telemetry') {
      void renderTelemetry();
    } else if(state.activeView==='discover'&&state.mixes.length) {
      renderDiscover();
    } else {
      if (state.discovery.length) renderTracks(navigator.onLine ? 'Discovery mix' : 'Saved discovery', state.discovery);
      else renderEmpty('Connect to your AuraAudio server once to load discovery for offline use.');
    }
    void pending;
  }
  function openPlaylist(playlist){const tracks=mergeTracks(playlist.tracks||[]);content.replaceChildren();const h=document.createElement('h2');h.className='content-heading';h.textContent=playlist.name||'Playlist';content.append(h);const actions=document.createElement('div');actions.className='overlay-actions';const play=document.createElement('button');play.textContent='▶ Play';play.onclick=()=>playTrack(tracks[0],tracks);const queue=document.createElement('button');queue.textContent='☷ Queue';queue.onclick=()=>{state.queue=tracks;renderQueue();$('#queuePanel').hidden=false};const download=document.createElement('button');download.textContent=nativeApp?'Online downloads need server':'⬇ Save on server';download.disabled=nativeApp;download.onclick=()=>void queueServerDownloads(tracks).catch(error=>showMessage(error.message,true));actions.append(play,queue,download);content.append(actions);renderTracks('Playlist tracks',tracks)}

  async function renderLocalDownloads(){const requestId=++downloadsRenderGeneration;content.replaceChildren();const items=nativeApp?await allAudio():await allAudio().catch(()=>[]);if(requestId!==downloadsRenderGeneration||state.activeView!=='downloads')return;state.downloads=items;const local=items.map(x=>({...x.track,deviceAudioKey:x.key,downloadedLocal:true}));if(local.length)renderTracks('Saved on this device',local);else renderEmpty(nativeApp?'No audio saved on this device yet. Import audio files in Settings; online downloads are not available in standalone mode.':'No audio saved on this device yet. Tap ⬇ on a track while online.');if(!nativeApp&&navigator.onLine)try{const remote=await api('/api/library/downloads');if(requestId!==downloadsRenderGeneration||state.activeView!=='downloads')return;state.serverDownloads=Array.isArray(remote)?remote:[];if(state.serverDownloads.length)renderTracks('Server downloads',state.serverDownloads.map(track=>({...track,serverDownload:true})));}catch(error){if(requestId===downloadsRenderGeneration&&!local.length)showMessage(`Server downloads unavailable: ${error.message}`,true)}}
  function artistKey(artist){return String(artist?.id||artist?.key||artist?.name||artist?.title||'').trim().toLocaleLowerCase()}
  function isLikedArtist(artist){const key=artistKey(artist);return !!key&&state.likedArtists.some(item=>artistKey(item)===key||String(item.name||'').toLocaleLowerCase()===String(artist?.name||artist?.title||'').toLocaleLowerCase())}
  function renderLikedArtists(){const artists=state.likedArtists||[];if(!artists.length)return;const heading=document.createElement('h2');heading.className='content-heading';heading.textContent=`Liked artists · ${artists.length}`;content.append(heading);const grid=document.createElement('div');grid.className='liked-artist-grid';for(const artist of artists){const tile=document.createElement('button');tile.type='button';tile.className='liked-artist-tile';const art=document.createElement('span');art.className='liked-artist-art';const src=artist.image||artist.cover||artist.artwork||artist.avatar||'';if(src){const image=document.createElement('img');image.alt='';image.loading='lazy';image.onerror=()=>{image.remove();art.textContent=(artist.name||artist.title||'♫').slice(0,1).toLocaleUpperCase()};void setImageSource(image,src);art.append(image)}else art.textContent=(artist.name||artist.title||'♫').slice(0,1).toLocaleUpperCase();const name=document.createElement('span');name.className='liked-artist-name';name.textContent=artist.name||artist.title||'Artist';tile.append(art,name);tile.onclick=()=>openArtist(name.textContent,artist);grid.append(tile)}content.append(grid)}
  async function refreshLikedArtistImages(){if(nativeApp||!navigator.onLine||!state.likedArtists.some(artist=>!artist.image&&!artist.cover&&!artist.artwork)||Date.now()-lastArtistImageRefresh<600000)return;lastArtistImageRefresh=Date.now();try{await api('/api/library/artists/refresh-images',{method:'POST',body:JSON.stringify({})});const artists=await api('/api/library/artists/liked');if(Array.isArray(artists)){state.likedArtists=artists;await saveState();if(['liked','library'].includes(state.activeView))render()}}catch(error){console.debug('Liked artist image refresh unavailable:',error.message)}}
  async function toggleLikedArtist(artist){const liked=!isLikedArtist(artist),record={id:String(artist.id||artist.key||artist.name||''),name:String(artist.name||artist.title||''),image:String(artist.image||artist.cover||artist.artwork||'')};if(!record.name)return;state.likedArtists=liked?state.likedArtists.filter(item=>artistKey(item)!==artistKey(record)).concat(record):state.likedArtists.filter(item=>artistKey(item)!==artistKey(record));await putAction({id:crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random()}`,type:'artist-like',liked,artist:record,createdAt:Date.now()});await saveState();if(state.activeView==='liked')render();showMessage(liked?'Artist saved to your liked artists.':'Artist removed from your liked artists.');if(navigator.onLine)void syncNow()}
  function mixStorageKey(mix){return String(mix.id||mix.title||mix.name||'mix')}
  function lockedMixMap(){try{return JSON.parse(localStorage.getItem('aura_autonomous_locked_mix_tracks')||'{}')}catch{return {}}}
  function isMixTrackLocked(mix,track){return (lockedMixMap()[mixStorageKey(mix)]||[]).some(item=>trackKey(item)===trackKey(track))}
  function setMixTrackLocked(mix,track,locked){const saved=lockedMixMap(),key=mixStorageKey(mix),rows=saved[key]||[];saved[key]=locked?[...rows.filter(item=>trackKey(item)!==trackKey(track)),track]:rows.filter(item=>trackKey(item)!==trackKey(track));if(!saved[key].length)delete saved[key];localStorage.setItem('aura_autonomous_locked_mix_tracks',JSON.stringify(saved));showMessage(locked?'Song will stay when this mix refreshes.':'Song can change when this mix refreshes.')}
  function renderMixTracks(mix){const tracks=mix.tracks||mix.items||[];content.replaceChildren();const actions=document.createElement('div');actions.className='overlay-actions';const back=document.createElement('button');back.type='button';back.textContent='← Discovery';back.onclick=()=>renderDiscover();const play=document.createElement('button');play.type='button';play.textContent='▶ Play mix';play.onclick=()=>void playTrack(tracks[0],tracks);const queue=document.createElement('button');queue.type='button';queue.textContent='☷ Add to queue';queue.onclick=()=>{state.queue.push(...tracks);renderQueue();$('#queuePanel').hidden=false};const refresh=document.createElement('button');refresh.type='button';refresh.textContent='↻ Refresh mix';refresh.onclick=()=>void refreshMix(mix,refresh);actions.append(back,play,queue,refresh);content.append(actions);renderTracks(mix.title||mix.name||'Mood mix',tracks,mix)}
  async function refreshMix(mix,button){button.disabled=true;button.textContent='Refreshing…';try{let found=null,offset=0;for(let page=0;page<12&&!found;page++){const data=await api(`/api/discovery/daily-mix?offset=${offset}&limit=8&refresh=${Date.now()}`);const rows=Array.isArray(data)?data:data?.mixes||[];found=rows.find(item=>item.id===mix.id||(!mix.id&&item.title===mix.title));offset=Number(data?.nextOffset)||offset+8;if(data?.hasMore===false||!rows.length)break}if(!found)throw new Error('The server did not return a refreshed version of this mix.');const locks=lockedMixMap()[mixStorageKey(mix)]||[],lockedKeys=new Set(locks.map(trackKey)),fresh=(found.tracks||[]).filter(track=>!lockedKeys.has(trackKey(track))),merged=mergeTracks(locks,fresh).slice(0,12);found={...found,tracks:merged};state.mixes=state.mixes.map(item=>mixStorageKey(item)===mixStorageKey(mix)?found:item);rememberTracks(merged);await saveState();renderMixTracks(found);showMessage('Mix refreshed; locked tracks were kept.')}catch(error){showMessage(`Could not refresh this mix: ${error.message}`,true);button.disabled=false;button.textContent='↻ Refresh mix'}}
  async function openTrackActions(track){const overlay=$('#trackActionsOverlay'),buttons=$('#trackActionsButtons');buttons.replaceChildren();$('#trackActionsTitle').textContent=track.title||track.name||track.trackName||'Track options';overlay.hidden=false;const add=(label,fn,danger=false)=>{const b=document.createElement('button');b.type='button';b.textContent=label;if(danger)b.className='settings-danger';b.onclick=async()=>{try{await fn();overlay.hidden=true}catch(error){showMessage(error.message,true)}};buttons.append(b)};if(track.artist&&!/^(?:unknown artist|youtube(?: audio)?)$/i.test(track.artist))add('♬  See artist',()=>openArtist(track.artist,track));if(track.album||track.albumTitle)add('▤  See album',()=>void openAlbum(track.album||track.albumTitle,[track],track.artist||''));add('⏭  Add to queue',()=>{state.queue.push(track);renderQueue();$('#queuePanel').hidden=false;showMessage('Added to queue.')});add('＋  Add to playlist',async()=>{const playlists=await api('/api/library/playlists');state.playlists=Array.isArray(playlists)?playlists:[];if(!state.playlists.length)throw new Error('Create a playlist first.');const list=state.playlists.map((p,i)=>`${i+1}. ${p.name}`).join('\n');const choice=Number(prompt(`Add to playlist:\n${list}`));const playlist=state.playlists[choice-1];if(!playlist)return;await api(`/api/library/playlists/${encodeURIComponent(playlist.id)}/tracks`,{method:'POST',body:JSON.stringify({track:{...track,title:track.title||track.name||'',artist:track.artist||'',source:track.source||'autonomous-client',sourceUrl:track.sourceUrl||track.externalUrl||'',url:track.url||track.streamUrl||''}})});showMessage(`Added to ${playlist.name}.`)});add('↗  Share',async()=>{const title=track.title||track.name||'AuraAudio track',text=[title,track.artist].filter(Boolean).join(' · '),url=track.externalUrl||track.youtubeUrl||track.sourceUrl;if(navigator.share)await navigator.share({title,text,url});else if(navigator.clipboard){await navigator.clipboard.writeText([text,url].filter(Boolean).join('\n'));showMessage('Track details copied.')}else throw new Error('Sharing is not available on this device.')});if(isLiked(track))add('♥  Unlike',()=>toggleTrack(track));if(track.downloadedLocal||track.deviceAudioKey)add('⌫  Remove downloaded audio from this device',async()=>{const key=track.deviceAudioKey||trackKey(track);await deleteAudio(key);state.downloads=await allAudio();showMessage('Downloaded audio removed from this device.');render() },true);if(track.serverDownload&&track.fileName)add('⌫  Delete server download',async()=>{if(!confirm(`Delete ${track.title||track.fileName} from the server?`))return;await api('/api/library/downloads',{method:'DELETE',body:JSON.stringify({fileName:track.fileName})});showMessage('Server download deleted.');render() },true);}
  function appendTrackActions(track){
    const buttons=$('#trackActionsButtons'),overlay=$('#trackActionsOverlay');
    const makeButton=(label,callback)=>{const button=document.createElement('button');button.type='button';button.textContent=label;button.addEventListener('click',async()=>{try{await callback();overlay.hidden=true}catch(error){showMessage(error.message,true)}});buttons.prepend(button)};
    makeButton('♫  Make a Jam / request track',()=>useJam(track));
    makeButton('⬇  Download on server in background',()=>queueServerDownloads([track]));
  }
  async function renderTelemetry(){if(!navigator.onLine){renderEmpty('Telemetry is available when connected to your server.');return}try{const data=await api('/api/telemetry');const totals=data.totals||{};const grid=document.createElement('div');grid.className='telemetry-grid';for(const label of ['plays','likes','downloads','playlists','diagnostics']){const card=document.createElement('div');card.className='stat';const n=document.createElement('strong');n.textContent=String(totals[label]||0);const t=document.createElement('span');t.textContent=label;card.append(n,t);grid.append(card)}content.append(grid);if(data.topArtists?.length)renderTracks('Top artists',data.topArtists.map(x=>({title:x.name,artist:`${x.count} plays`})))}catch(e){renderEmpty(`Telemetry unavailable: ${e.message}`)}}

  function directAudioUrl(track){let candidate=track.streamUrl||track.audioUrl||track.fileUrl||track.filePath||'';if(!candidate&&track.url&&!/youtube\.com|youtu\.be/i.test(track.url)&&(/\/api\/media\//i.test(track.url)||/\.(mp3|m4a|aac|ogg|opus|wav|flac)(?:[?#]|$)/i.test(track.url)))candidate=track.url;if(!candidate||/youtube\.com|youtu\.be/i.test(candidate))return '';return candidate.startsWith('/')?baseUrl()+candidate:candidate}
  async function resolveAudioBlob(track){if(nativeApp)throw new Error('Online downloads are not available in the standalone app yet. Import audio files to store and play them securely on this device.');let url=directAudioUrl(track);if(url){const response=await fetch(url,{headers:apiHeaders(),signal:AbortSignal.timeout(180000)});if(!response.ok)throw new Error(`Audio fetch failed (${response.status})`);const blob=await response.blob();if(blob.size)return blob;throw new Error('The server returned an empty audio file.')}
    if(!navigator.onLine)throw new Error('This audio is not saved on the device. Connect and tap download first.');
    const source=track.sourceUrl||track.playQuery||track.youtubeUrl||track.externalUrl||track.url||`${track.title||track.name||''} ${track.artist||''}`.trim();if(!source)throw new Error('This result has no playable audio URL.');
    const job=await api('/api/ytb/download',{method:'POST',body:JSON.stringify({url:source,title:track.title||track.name})});if(!job.id)throw new Error('The server did not start an audio download.');serverJobIds.add(job.id);
    try{for(let i=0;i<300;i++){await new Promise(r=>setTimeout(r,1500));const progress=await api(`/api/ytb/progress/${encodeURIComponent(job.id)}`);if(progress.status==='completed'){const downloaded={...track,...(progress.result||{})};const result={...downloaded,title:track.title||track.name||downloaded.title,artist:track.artist||track.channel||track.uploader||downloaded.artist};url=directAudioUrl(downloaded);if(!url)throw new Error('The completed download did not include a playable audio URL.');const response=await fetch(url,{headers:apiHeaders(),signal:AbortSignal.timeout(180000)});if(!response.ok)throw new Error(`Audio fetch failed (${response.status})`);const blob=await response.blob();if(!blob.size)throw new Error('The server returned an empty audio file.');return {blob,track:result}}if(progress.status==='failed')throw new Error(progress.error||'Server audio download failed');if(progress.status==='unknown')throw new Error('The server no longer has this download job. Restart the download.')}
      throw new Error('Audio download is still processing; try again shortly.')}finally{serverJobIds.delete(job.id)}}
  async function downloadTrack(track){const key=trackKey(track);if(downloadJobs.has(key)){showMessage('This track is already being saved.');return}downloadJobs.add(key);try{showMessage('Saving audio to this device…');const resolved=await resolveAudioBlob(track);const finalTrack={...resolved.track,title:track.title||track.name||resolved.track.title,artist:track.artist||track.channel||track.uploader||resolved.track.artist};await writeAudio(trackKey(finalTrack),finalTrack,resolved.blob);rememberTracks([finalTrack]);showMessage(`${finalTrack.title||finalTrack.name} saved for offline playback.`);if(state.activeView==='downloads'||state.activeView==='library')render()}catch(e){showMessage(e.message,true)}finally{downloadJobs.delete(key)}}
  function fmtTime(n){if(!Number.isFinite(n))return '0:00';return `${Math.floor(n/60)}:${String(Math.floor(n%60)).padStart(2,'0')}`}
  let mediaSessionActionsRegistered=false;
  function updateMediaSession(track){
    if(!('mediaSession'in navigator)||!navigator.mediaSession||!track)return;
    const session=navigator.mediaSession,audio=$('#audio');
    if(typeof window.MediaMetadata==='function'){
      const artwork=track.cover||track.image||'';
      try{session.metadata=new MediaMetadata({title:track.title||track.name||'AuraAudio',artist:track.artist||'AuraAudio',album:track.album||'',artwork:artwork?[{src:artwork,sizes:'512x512'}]:[]})}
      catch(error){console.warn('[Media Session] Could not update metadata:',error)}
    }
    if(!mediaSessionActionsRegistered){
      const handlers={
        play:()=>audio.play().catch(error=>showMessage(`Playback could not resume: ${error.message}`,true)),
        pause:()=>audio.pause(),
        previoustrack:()=>moveTrack(-1),
        nexttrack:()=>moveTrack(1),
        seekto:event=>{if(Number.isFinite(event.seekTime)&&Number.isFinite(audio.duration))audio.currentTime=Math.max(0,Math.min(event.seekTime,audio.duration))},
        seekbackward:event=>{if(Number.isFinite(audio.currentTime))audio.currentTime=Math.max(0,audio.currentTime-(event.seekOffset||10))},
        seekforward:event=>{if(Number.isFinite(audio.currentTime))audio.currentTime=Math.min(Number.isFinite(audio.duration)?audio.duration:Infinity,audio.currentTime+(event.seekOffset||10))}
      };
      for(const [action,handler] of Object.entries(handlers)){try{session.setActionHandler(action,handler)}catch(error){if(!(error instanceof TypeError))throw error}}
      mediaSessionActionsRegistered=true;
    }
    if(Number.isFinite(audio.duration)&&audio.duration>0&&typeof session.setPositionState==='function'){
      try{session.setPositionState({duration:audio.duration,playbackRate:audio.playbackRate,position:Math.min(audio.currentTime,audio.duration)})}catch(error){if(!(error instanceof TypeError))throw error}
    }
  }
  $('#audio').addEventListener('loadedmetadata',()=>updateMediaSession(state.queue[state.current]));
  $('#audio').addEventListener('timeupdate',()=>{const session=navigator.mediaSession,audio=$('#audio');if(session&&typeof session.setPositionState==='function'&&Number.isFinite(audio.duration)&&audio.duration>0)try{session.setPositionState({duration:audio.duration,playbackRate:audio.playbackRate,position:Math.min(audio.currentTime,audio.duration)})}catch(error){if(!(error instanceof TypeError))throw error}});
  $('#audio').addEventListener('play',()=>{if('mediaSession'in navigator)navigator.mediaSession.playbackState='playing'});
  $('#audio').addEventListener('pause',()=>{if('mediaSession'in navigator)navigator.mediaSession.playbackState='paused'});
  let lyrics=[];
  function lyricsLookup(track){let title=String(track?.title||track?.name||track?.trackName||'').replace(/&amp;/gi,'&').replace(/&#39;|&apos;/gi,"'").replace(/&quot;/gi,'"').trim();let artist=String(track?.artist||track?.channel||track?.uploader||'').trim();const split=title.match(/^(.{1,100}?)\s+-\s+(.{1,180})$/);if(split&&(/^(?:youtube(?: audio)?|unknown artist|unknown)$/i.test(artist)||/vevo|topic|official/i.test(artist))){artist=split[1].trim();title=split[2].trim()}title=title.replace(/[[(](?:[^)\]]*(?:official|video|lyrics?|audio|explicit|remaster(?:ed)?|international\s+version|radio\s+edit|single\s+version)[^)]*)[)\]]/gi,' ').replace(/\s*[|–—]\s*(?:official|lyrics?|music video|audio).*$/i,' ').replace(/\s+-\s+(?:\d{4}\s+)?remaster(?:ed)?\b.*$/i,' ').replace(/\s+/g,' ').trim();artist=artist.replace(/\s*(?:-\s*)?(?:VEVO|Topic|Official)$/i,'').trim();if(/^(?:unknown artist|youtube(?: audio)?|unknown)$/i.test(artist))artist='';return{title,artist}}
  function updateLyricsDisplay(time=$('#audio').currentTime||0){const lyricsBox=$('#lyricsText'),count=state.lyricLines;lyricsBox.dataset.lines=String(count);if(!lyrics.length){lyricsBox.textContent='No lyrics available for this track.';return}let active=0;for(let i=0;i<lyrics.length;i++){if(lyrics[i].t<=time)active=i;else break}const start=Math.max(0,Math.min(lyrics.length-count,active-Math.floor(count/2)));lyricsBox.replaceChildren();for(let i=start;i<Math.min(lyrics.length,start+count);i++){const line=document.createElement('div');line.className=`lyrics-line${i===active?' active':''}`;line.textContent=lyrics[i].text;lyricsBox.append(line)}}
  async function openLyrics(){const track=state.queue[state.current];$('#lyricsOverlay').hidden=false;$('#lyricsTitle').textContent=track?.title||'Lyrics';$('#lyricsArtist').textContent=track?.artist||'';$('#lyricsText').textContent='Loading lyrics…';if(!track)return;if(!lyrics.length){try{const query=lyricsLookup(track),data=await api(`/api/lyrics?title=${encodeURIComponent(query.title)}&artist=${encodeURIComponent(query.artist)}`);lyrics=(data.lines||data.lyrics||[]).map(x=>({t:Number(x.t||x.time||0),text:x.text||''})).filter(x=>x.text)}catch(e){$('#lyricsText').textContent=`Lyrics could not be loaded: ${e.message}`;return}}updateLyricsDisplay()}
  function renderQueue(){const list=$('#queueList');list.replaceChildren();state.queue.forEach((t,i)=>{const row=document.createElement('div');row.className=`queue-item${i===state.current?' current':''}`;const select=document.createElement('button');select.type='button';select.className='queue-select';select.textContent=`${i===state.current?'♫':`${i+1}.`} ${t.title||t.name} · ${t.artist||''}`;select.setAttribute('aria-label',`Play ${t.title||t.name||'track'} by ${t.artist||'unknown artist'}`);select.onclick=()=>void playTrack(t,state.queue);const remove=document.createElement('button');remove.type='button';remove.className='queue-remove';remove.textContent='×';remove.setAttribute('aria-label',`Remove ${t.title||t.name} from queue`);remove.onclick=()=>{state.queue.splice(i,1);if(i<state.current)state.current--;else if(i===state.current){state.current=Math.min(i,state.queue.length-1);if(state.current>=0)void playTrack(state.queue[state.current],state.queue);else{$('#audio').pause();$('#playerTitle').textContent='Nothing playing';$('#playerArtist').textContent='Choose a track'}}renderQueue()};row.append(select,remove);list.append(row)});$('#queueCount').textContent=String(state.queue.length)}
  async function playTrack(track, list){if(!track){showMessage('This playlist has no playable tracks.',true);return}try{state.queue=Array.isArray(list)&&list.length?list:[track];state.current=Math.max(0,state.queue.findIndex(t=>trackKey(t)===trackKey(track)));let blob=await readAudio(trackKey(track));if(!blob){const resolved=await resolveAudioBlob(track);blob=resolved.blob;track=resolved.track;await writeAudio(trackKey(track),track,blob);rememberTracks([track])}if(!blob)throw new Error('No audio source found for this track. Use Download to save playable audio.');const audio=$('#audio');if(audio.src.startsWith('blob:'))URL.revokeObjectURL(audio.src);audio.src=URL.createObjectURL(blob);$('#playerTitle').textContent=track.title||track.name||'Unknown track';$('#playerArtist').textContent=track.artist||'';void setImageSource($('#playerCover'),track.cover||track.image||'');$('#fullTitle').textContent=track.title||track.name||'';$('#fullArtist').textContent=track.artist||'';void setImageSource($('#fullCover'),track.cover||track.image||'');renderQueue();lyrics=[];$('#lyricsPreview').textContent='Loading lyrics…';const lyricQuery=lyricsLookup(track);void api(`/api/lyrics?title=${encodeURIComponent(lyricQuery.title)}&artist=${encodeURIComponent(lyricQuery.artist)}`).then(data=>{lyrics=(data.lines||data.lyrics||[]).map(x=>({t:Number(x.t||x.time||0),text:x.text||''})).filter(x=>x.text);$('#lyricsPreview').textContent=lyrics[0]?.text||'Lyrics unavailable'}).catch(()=>{$('#lyricsPreview').textContent='Lyrics unavailable'});void api('/api/library/played',{method:'POST',body:JSON.stringify({track:{title:track.title||track.name||'',artist:track.artist||''},listenedSeconds:0})}).catch(()=>{});await audio.play();$('#playTrack').textContent='Ⅱ';$('#fullPlay').textContent='Ⅱ';}catch(e){showMessage(`Playback failed: ${e.message}`,true)}}
  function moveTrack(delta){if(!state.queue.length)return;if(delta>0){if(state.repeat==='one'){const a=$('#audio');a.currentTime=0;void a.play();return}if(state.shuffle&&state.queue.length>1){let next=state.current;while(next===state.current)next=Math.floor(Math.random()*state.queue.length);state.current=next}else if(state.current+1<state.queue.length)state.current++;else if(state.repeat==='all')state.current=0;else return}else if(state.current>0)state.current--;else if(state.repeat==='all')state.current=state.queue.length-1;else{$('#audio').currentTime=0;return}void playTrack(state.queue[state.current],state.queue)}

  async function toggleTrack(track) {
    const key = trackKey(track);
    const liked = !isLiked(track);
    state.liked = liked ? mergeTracks(state.liked, [track]) : state.liked.filter(item => trackKey(item) !== key);
    const queuedTrack = {
      id: String(track.id || track.trackId || key).slice(0, 240),
      title: String(track.title || track.name || '').slice(0, 240),
      artist: String(track.artist || 'Unknown Artist').slice(0, 180),
      duration: Number(track.duration) || 0,
      durationFormatted: String(track.durationFormatted || '').slice(0, 24),
      cover: typeof track.cover === 'string' ? track.cover.slice(0, 1500) : '',
      source: String(track.source || 'autonomous-client').slice(0, 40)
    };
    await putAction({ id: (crypto.randomUUID ? crypto.randomUUID() : [Date.now(), Math.random().toString(16).slice(2), Math.random().toString(16).slice(2)].join('-')), type: 'track-like', liked, track: queuedTrack, createdAt: Date.now() });
    await saveState();
    showMessage(liked ? 'Like saved on this device. It will sync when the server is reachable.' : 'Unlike saved on this device. It will sync when the server is reachable.');
    render();
    if (navigator.onLine) void syncNow();
  }

  function updateFromServer(payload) {
    if (Array.isArray(payload.likedSongs)) state.liked = payload.likedSongs;
    if (Array.isArray(payload.likedArtists)) state.likedArtists = payload.likedArtists;
  }

  async function applyQueuedTrackStates() {
    const queued = await listActions();
    for (const action of queued) {
      if(action.type==='artist-like'&&action.artist){const key=artistKey(action.artist);state.likedArtists=action.liked?[...state.likedArtists.filter(item=>artistKey(item)!==key),action.artist]:state.likedArtists.filter(item=>artistKey(item)!==key);continue}
      if (action.type !== 'track-like' || !action.track) continue;
      const key = trackKey(action.track);
      state.liked = action.liked ? mergeTracks(state.liked, [action.track]) : state.liked.filter(track => trackKey(track) !== key);
    }
  }

  async function syncNow() {
    if (state.syncing) return;
    if(nativeApp){
      state.syncing=true;
      try{
        await applyQueuedTrackStates();
        await saveState();
        await deleteActions((await listActions()).map(action=>action.id));
        $('#syncStatus').textContent='Saved locally. Connect to desktop only when you want to transfer your library by QR.';
        render();
      }catch(error){
        $('#syncStatus').textContent='Could not save local changes.';
        showMessage(`Could not save local changes: ${error.message}`,true);
      }finally{state.syncing=false}
      return;
    }
    if (!navigator.onLine) { showMessage('Offline. Changes are saved and will retry when you reconnect.', true); return; }
    if (!baseUrl()) { showMessage('Open connection settings to enter your AuraAudio server URL.', true); return; }
    state.syncing = true;
    $('#syncButton').disabled = true;
    try {
      const actions = await listActions();
      if (actions.length) {
        const payload = await api('/api/mobile/sync', { method: 'POST', body: JSON.stringify({ actions: actions.slice(0, 200) }) });
        await deleteActions(payload.accepted || []);
        updateFromServer(payload);
      }
      const [liked, artists] = await Promise.all([api('/api/library/liked'), api('/api/library/artists/liked')]);
      state.liked = mergeTracks(Array.isArray(liked) ? liked : []);
      state.likedArtists = Array.isArray(artists) ? artists : [];
      await applyQueuedTrackStates();
      await saveState();
      void refreshLikedArtistImages();
      const remaining = await listActions();
      $('#syncStatus').textContent = remaining.length ? `${remaining.length} changes still waiting to sync.` : 'Everything is synced with your server.';
      showMessage(remaining.length ? 'Some changes remain queued. Sync again when the connection is stable.' : 'Library synchronized.');
      render();
    } catch (error) {
      const actions = await listActions().catch(() => []);
      $('#syncStatus').textContent = actions.length ? `${actions.length} changes saved for later.` : 'Server unavailable; this device keeps its own copy.';
      const isNetwork = /failed to fetch|network|timeout|aborted/i.test(error.message || '');
      if (isNetwork) {
        try { $('#connectionPanel').hidden = false; $('#connectionToggle').setAttribute('aria-expanded', 'true'); } catch {}
      }
      showMessage(isNetwork
        ? 'Cannot reach the server. Check the URL (include the port, e.g. :32768), HTTPS certificate, port forwarding, and that the server PowerShell window is still open.'
        : (error.message || 'Connection failed.'), true);
    } finally {
      state.syncing = false;
      $('#syncButton').disabled = false;
      setOnlineStatus();
    }
  }

  function rememberTracks(tracks) {
    state.catalog = mergeTracks(state.catalog, tracks).slice(-700);
  }

  function offlineSearch(query) {
    const q = query.trim().toLocaleLowerCase();
    return mergeTracks(state.catalog, state.liked, state.discovery).filter(track => `${track.title || track.name || ''} ${track.artist || ''}`.toLocaleLowerCase().includes(q)).slice(0, 80);
  }

  async function search(query) {
    const q = query.trim();
    if (!q) return;
    state.activeView = 'search';
    document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === 'search'));
    state.searchResults = offlineSearch(q);
    state.searchArtists = [];
    state.searchYoutube = [];
    state.searchOnline = false;
    render();
    if (!navigator.onLine || !baseUrl()) {
      showMessage(state.searchResults.length ? 'Showing music cached on this device.' : 'No matching cached music. Connect a server to search its library.', !state.searchResults.length);
      return;
    }
    showMessage('Searching the server…');
    try {
      const result = await api(`/api/search?q=${encodeURIComponent(q)}`);
      console.log('[Mobile Search] Result:', result);
      const tracks = mergeTracks(result.tracks || [], result.library || []);
      state.searchArtists = Array.isArray(result.artists) ? result.artists : [];
      state.searchYoutube = mergeTracks((result.youtube || []).map(t => {
        let title = t.title || t.name || t.trackName || 'Untitled video';
        let artist = t.artist || t.channel || t.uploader || '';
        const parsed = title.match(/^(.{1,100}?)\s+-\s+(.{1,160})$/);
        if (parsed && !artist) {
          artist = parsed[1].trim();
          title = parsed[2].trim();
        }
        return {
          ...t,
          title,
          artist: artist || 'YouTube',
          source: 'youtube',
          youtubeUrl: t.externalUrl || t.url,
          sourceUrl: t.externalUrl || t.url,
          cover: t.thumbnail || t.cover || ''
        };
      }));
      state.searchYoutube = state.searchYoutube.filter(t => !tracks.some(found => trackKey(found) === trackKey(t)));
      rememberTracks(tracks);
      state.searchResults = tracks;
      state.searchOnline = true;
      await saveState();
      render();
      showMessage(tracks.length || state.searchArtists.length || state.searchYoutube.length ? 'Search results loaded.' : 'No matching tracks found.');
    } catch (error) {
      console.debug('[Search] Server error:', error.message);
      state.searchResults = offlineSearch(q);
      state.searchOnline = false;
      render();
      showMessage(state.searchResults.length ? `Server search failed. Showing saved results. ${error.message}` : `Search needs a server connection. ${error.message}`, true);
    }
  }

  function unpackMixes(data) {
    const mixes = Array.isArray(data) ? data : data?.mixes || [];
    state.mixes = Array.isArray(mixes) ? mixes.filter(mix=>mix&&typeof mix==='object') : [];
    const tracks = mixes.flatMap(mix => Array.isArray(mix.tracks) ? mix.tracks : Array.isArray(mix.items) ? mix.items : []);
    return mergeTracks(tracks);
  }

  function renderDiscover(){content.replaceChildren();const refresh=document.createElement('button');refresh.type='button';refresh.className='sync';refresh.textContent='↻ Refresh recommendations';refresh.style.cssText='display:block;margin:6px auto 14px';refresh.onclick=()=>void loadDiscovery(true);content.append(refresh);const heading=document.createElement('h2');heading.className='content-heading';heading.textContent=`Mood mixes · ${state.mixes.length}`;content.append(heading);const grid=document.createElement('div');grid.className='autonomous-mix-grid';for(const mix of state.mixes){const tracks=Array.isArray(mix.tracks)?mix.tracks:Array.isArray(mix.items)?mix.items:[];const card=document.createElement('button');card.type='button';card.className='autonomous-mix-card';const covers=[...new Set(tracks.map(t=>t.cover||t.image).filter(Boolean))].slice(0,4);const art=document.createElement('span');art.className='autonomous-mix-art';covers.forEach(src=>{const image=document.createElement('img');image.alt='';image.loading='lazy';image.onerror=()=>image.remove();void setImageSource(image,src);art.append(image)});if(!covers.length){const fallback=document.createElement('span');fallback.textContent='♫';art.append(fallback)}const copy=document.createElement('span');copy.className='autonomous-mix-copy';const badge=document.createElement('small');badge.textContent=mix.badge||'MOOD MIX';const name=document.createElement('strong');name.textContent=mix.title||mix.name||mix.label||'Aura mix';const description=document.createElement('span');description.textContent=mix.description||`${tracks.length} tracks selected for this mood`;copy.append(badge,name,description);card.append(art,copy);card.onclick=()=>renderMixTracks(mix);grid.append(card)}content.append(grid);if(state.discoveryHasMore){const more=document.createElement('button');more.type='button';more.className='sync';more.textContent='Load more moods';more.style.cssText='display:block;margin:14px auto';more.onclick=async()=>{more.disabled=true;more.textContent='Loading moods…';try{const data=await api(`/api/discovery/daily-mix?offset=${state.discoveryOffset}&limit=6`);const rows=Array.isArray(data)?data:data?.mixes||[];state.mixes.push(...rows.filter(x=>x&&typeof x==='object'));state.discoveryOffset=Number(data?.nextOffset)||state.discoveryOffset+6;state.discoveryHasMore=data?.hasMore===true;rememberTracks(rows.flatMap(x=>x.tracks||[]));await saveState();renderDiscover()}catch(e){more.disabled=false;more.textContent='Load more moods';showMessage(`Could not load more moods: ${e.message}`,true)}};content.append(more)}
    const releases=document.createElement('section');releases.className='autonomous-releases';const releaseHeading=document.createElement('h2');releaseHeading.className='content-heading';releaseHeading.textContent='Latest releases · Albums & singles';releases.append(releaseHeading);const status=document.createElement('p');status.className='search-results-note';status.textContent='Loading new releases…';releases.append(status);content.append(releases);if(navigator.onLine)void api('/api/discovery/releases').then(data=>{if(!releases.isConnected)return;const items=Array.isArray(data?.releases)?data.releases:[];status.textContent=items.length?'New albums and singles from live music metadata.':'No new releases are available right now.';const list=document.createElement('div');list.className='autonomous-release-list';for(const release of items){const button=document.createElement('button');button.type='button';button.className='autonomous-release';const image=document.createElement('img');image.alt='';image.loading='lazy';image.onerror=()=>image.remove();if(release.cover)void setImageSource(image,release.cover);const copy=document.createElement('span');copy.innerHTML='';const title=document.createElement('strong');title.textContent=release.title||'Untitled release';const meta=document.createElement('small');meta.textContent=[release.artist,release.type,release.date].filter(Boolean).join(' · ');copy.append(title,meta);button.append(image,copy);button.onclick=()=>void openAlbum(release.title||'',[],release.artist||'');list.append(button)}releases.append(list)}).catch(error=>{if(releases.isConnected)status.textContent=`Latest releases unavailable: ${error.message}`});else status.textContent='Latest releases load when connected to your server.'}

  async function loadDiscovery(refresh = false) {
    state.activeView = 'discover';
    render();
    if (!navigator.onLine) {
      showMessage(state.discovery.length ? 'Showing your saved discovery metadata.' : 'Connect to your server to load discovery.', !state.discovery.length);
      return;
    }
    if (!baseUrl()) {
      showMessage('Open connection settings to enter your AuraAudio server URL.', true);
      return;
    }
    showMessage('Loading your discovery mix…');
    try {
      const result = await api(`/api/discovery/daily-mix?offset=0&limit=8${refresh?'&refresh='+Date.now():''}`);
      state.discovery = unpackMixes(result);
      state.discoveryOffset=Number(result?.nextOffset)||state.mixes.length;
      state.discoveryHasMore=result?.hasMore===true;
      rememberTracks(state.discovery);
      await saveState();
      render();
      showMessage(state.discovery.length ? 'Discovery is ready and saved on this device.' : 'Your server returned no mix tracks yet.');
    } catch (error) {
      render();
      showMessage(state.discovery.length ? `Showing saved discovery. ${error.message}` : `Could not load discovery. ${error.message}`, true);
    }
  }

  function chooseView(view) {
    state.activeView = view;
    document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
    if (view === 'discover') void loadDiscovery();
    else if (view === 'liked') { render(); if (navigator.onLine) void syncNow(); }
    else if(view==='search'){state.searchResults=[];render();$('#query').focus()}
    else if(view==='playlists'){render();if(navigator.onLine)void api('/api/library/playlists').then(x=>{state.playlists=Array.isArray(x)?x:[];render()}).catch(e=>showMessage(e.message,true))}
    else if(view==='downloads')render()
    else if(view==='telemetry'){render();void renderTelemetry()}
    else {state.searchResults=[];if(view==='library')void loadLibrary();else render()}
  }

  $('#connectionForm').addEventListener('submit', event => {
    event.preventDefault();
    const value = serverInput.value.trim();
    if (value) {
      try {
        const parsed = new URL(value);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Use an HTTP or HTTPS server URL.');
        const previousServer = localStorage.getItem(serverKey) || '';
        localStorage.setItem(serverKey, parsed.origin);
        if (previousServer !== parsed.origin) localStorage.removeItem(pairedTokenKey);
      } catch (error) { showMessage(error.message || 'Enter a valid server URL.', true); return; }
    } else {
      localStorage.removeItem(serverKey);
      localStorage.removeItem(pairedTokenKey);
    }
    showMessage('API server URL saved. Scan the matching server QR code to pair this phone.');
    if (navigator.onLine) { void syncNow(); if(state.activeView==='library')void loadLibrary(); if(state.activeView==='discover')void loadDiscovery(); }
  });

  $('#connectionToggle').addEventListener('click', () => {
    $('#settingsOverlay').hidden=false;
    void loadHistorySettings();
    void refreshDeviceStorage().catch(error=>settingsStatus(`Could not read app storage: ${error.message}`));
  });
  const connectionHelp = $('#connectionSettingsFromModal').closest('.settings-option')?.querySelector('small');
  if (connectionHelp) connectionHelp.textContent = 'Change the server URL, then scan its one-time QR code to pair this phone.';
  const settingsStatus=text=>{$('#settingsStatus').textContent=text};
  const transferOption=document.createElement('div');
  transferOption.className='settings-option';
  transferOption.innerHTML='<span>Send library to desktop<small>Scan a one-use desktop QR over private Wi-Fi. Records only; audio stays on this phone.</small></span><button id="sendLibraryTransfer" type="button">Scan QR</button>';
  $('#exportBackupButton').closest('.settings-option').after(transferOption);
  const transferOverlay=document.createElement('section');
  transferOverlay.className='settings-overlay';
  transferOverlay.hidden=true;
  transferOverlay.setAttribute('role','dialog');
  transferOverlay.setAttribute('aria-modal','true');
  transferOverlay.setAttribute('aria-labelledby','transferDialogTitle');
  transferOverlay.innerHTML='<div class="settings-card"><h2 id="transferDialogTitle">Send library to desktop</h2><p class="search-results-note">Keep both devices on the same private Wi-Fi. Scan the expiring QR shown in desktop Settings. Only likes, listening history, playlists, and download metadata are sent—never audio files.</p><input id="transferQrImage" hidden type="file" accept="image/*" capture="environment"><button id="captureTransferQr" type="button">Scan QR with camera</button><label class="settings-option" for="transferQrText"><span>QR text fallback<small>Paste the QR payload if image scanning is unavailable.</small></span></label><textarea id="transferQrText" rows="4" maxlength="1600" placeholder="AuraAudio library transfer QR data" style="width:100%;margin:8px 0;padding:10px;border:1px solid #30384a;border-radius:9px;background:#0d1018;color:#fff;font-size:11px;resize:vertical"></textarea><p id="transferStatus" role="status" aria-live="polite"></p><div style="display:flex;gap:8px;justify-content:flex-end"><button id="cancelTransfer" type="button">Cancel</button><button id="sendTransfer" type="button">Send records</button></div></div>';
  transferOverlay.querySelectorAll('button').forEach(button=>{button.style.cssText='min-height:38px;padding:8px 11px;border:1px solid #38415a;border-radius:9px;background:#20283a;color:#fff;font-size:12px;font-weight:700'});
  transferOverlay.querySelector('#sendTransfer').style.background='var(--accent)';
  document.body.append(transferOverlay);
  const transferStatus=$('#transferStatus');
  const transferInput=$('#transferQrImage');
  transferStatus.style.cssText='min-height:20px;margin:9px 0;color:#aeb8cb;font-size:11px;line-height:1.45';
  $('#content').addEventListener('click',event=>{
    if(!event.target.closest('[data-library-transfer]'))return;
    const transferButton=$('#sendLibraryTransfer');
    if(transferButton)transferButton.click();
    else showMessage('The secure library transfer is unavailable. Reopen Settings and try again.',true);
  });
  function privateTransferAddress(hostname){
    const host=String(hostname||'').replace(/^\[|\]$/g,'').toLowerCase();
    const octets=host.split('.').map(Number);
    if(octets.length===4&&octets.every(value=>Number.isInteger(value)&&value>=0&&value<=255)){
      const [a,b]=octets;
      return a===10||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===169&&b===254);
    }
    return host.startsWith('fc')||host.startsWith('fd')||/^fe[89ab]/.test(host);
  }
  async function decodeTransferQr(file){
    if(!('BarcodeDetector' in window))throw new Error('QR image scanning is unavailable in this browser. Paste the QR payload instead.');
    const detector=new BarcodeDetector({formats:['qr_code']});
    const codes=await detector.detect(file);
    if(!codes.length||!codes[0].rawValue)throw new Error('No QR code found in that image. Try again or paste the QR payload.');
    return codes[0].rawValue;
  }
  function validateTransferPayload(value){
    let payload;
    try{payload=JSON.parse(value)}catch{throw new Error('The scanned QR is not a valid AuraAudio transfer code.')}
    if(payload?.type!=='AuraAudio-library-transfer'||payload.version!==1||!/^[a-f0-9]{64}$/i.test(payload.token||''))throw new Error('This QR is not a supported AuraAudio library transfer.');
    let target;
    try{target=new URL(payload.receiverUrl)}catch{throw new Error('The desktop receiver URL is invalid.')}
    if(!['http:','https:'].includes(target.protocol)||target.username||target.password||target.search||target.hash||target.pathname!=='/api/library/transfer/import'||!privateTransferAddress(target.hostname))throw new Error('Transfer is allowed only to a private Wi-Fi/LAN address.');
    if(!Number.isFinite(Number(payload.expiresAt))||Number(payload.expiresAt)<=Date.now()||Number(payload.expiresAt)>Date.now()+4*60*1000)throw new Error('This desktop QR has expired. Create a fresh code in Settings.');
    return{...payload,receiverUrl:target.toString()};
  }
  $('#sendLibraryTransfer').addEventListener('click',()=>{transferOverlay.hidden=false;transferStatus.textContent='Scan the QR from desktop Settings, then send records.';$('#transferQrText').value=''});
  $('#captureTransferQr').addEventListener('click',()=>transferInput.click());
  transferInput.addEventListener('change',async()=>{
    const file=transferInput.files?.[0];if(!file)return;
    transferStatus.textContent='Reading the QR image locally…';
    try{$('#transferQrText').value=await decodeTransferQr(file);transferStatus.textContent='QR decoded. Review the destination, then send library records.'}
    catch(error){transferStatus.textContent=error.message}
    transferInput.value='';
  });
  $('#cancelTransfer').addEventListener('click',()=>{transferOverlay.hidden=true;transferInput.value='';$('#transferQrText').value=''});
  transferOverlay.addEventListener('click',event=>{if(event.target===transferOverlay)transferOverlay.hidden=true});
  $('#sendTransfer').addEventListener('click',async()=>{
    const button=$('#sendTransfer');button.disabled=true;
    try{
      const receiver=validateTransferPayload($('#transferQrText').value.trim());
      const destination=new URL(receiver.receiverUrl);
      if(!confirm(`Send likes, listening history, playlists, and download metadata to AuraAudio at ${destination.host}? Continue only if this matches your desktop server.`))return;
      transferStatus.textContent='Syncing any queued phone changes before the metadata-only export…';
      await syncNow();
      const pendingActions=await listActions();
      if(pendingActions.length)throw new Error(`${pendingActions.length} phone changes could not sync. Reconnect this phone to its server, then try the transfer again.`);
      transferStatus.textContent='Preparing a metadata-only library export…';
      const library=await api('/api/library/transfer/export');
      const body=JSON.stringify(library);
      if(new TextEncoder().encode(body).length>3*1024*1024)throw new Error('The library export exceeds the 3 MB safe transfer limit. Reduce the number of records and try again.');
      transferStatus.textContent='Sending records to the desktop over your private network…';
      let response;
      try{
        response=await fetch(receiver.receiverUrl,{method:'POST',mode:'cors',credentials:'omit',cache:'no-store',headers:{'Content-Type':'application/json','X-Aura-Library-Transfer-Token':receiver.token},body,signal:AbortSignal.timeout(25000)});
      }catch(error){throw new Error(`Desktop server is unreachable. Check that it is running, both devices share Wi-Fi, and the firewall allows AuraAudio (${error.message}).`)}
      const result=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(result.message||result.error||`Desktop server rejected the transfer (${response.status}). Create a fresh QR if this one expired.`);
      const count=result.imported||{};
      transferStatus.textContent=`Transfer complete: ${count.likedSongs||0} liked songs, ${count.likedArtists||0} artists, ${count.listeningHistory||0} plays, ${count.playlists||0} playlists, and ${count.downloadMetadata||0} download records imported. Audio files were not sent.`;
      showMessage('Library records transferred to the desktop. Audio files stayed on this phone.');
    }catch(error){transferStatus.textContent=`Transfer failed: ${error.message}`}
    finally{button.disabled=false}
  });
  const nativeConnectionOption=$('#connectionSettingsFromModal').closest('.settings-option');
  if(nativeApp){
    $('#connectionPanel').hidden=true;
    if(nativeConnectionOption)nativeConnectionOption.hidden=true;
    $('#connectionSettingsFromModal').hidden=true;
    $('#syncStatus').textContent='Your library and audio are stored privately on this device. Desktop QR sync is optional.';
  }
  const deviceStorageStatus=document.createElement('p');
  deviceStorageStatus.id='deviceStorageUsage';
  deviceStorageStatus.className='search-results-note';
  deviceStorageStatus.setAttribute('role','status');
  deviceStorageStatus.textContent='Checking app-private storage…';
  $('#clearImageCache').closest('.settings-option').before(deviceStorageStatus);
  async function refreshDeviceStorage(){
    if(nativeApp){
      const usage=await nativeCall('getStorageUsage');
      const audio=await allAudio();
      const format=bytes=>{if(bytes<1024)return`${bytes} B`;const units=['KB','MB','GB'];let value=bytes/1024,index=0;while(value>=1024&&index<units.length-1){value/=1024;index++}return`${value.toFixed(1)} ${units[index]}`};
      deviceStorageStatus.textContent=`App-private storage: ${format(usage.usageBytes||0)} used of ${format(usage.limitBytes||0)} (${format(usage.availableBytes||0)} available). ${audio.length} audio file${audio.length===1?'':'s'} stored.`;
      return;
    }
    const estimate=await navigator.storage?.estimate?.();
    deviceStorageStatus.textContent=estimate?.usage!==undefined?`Browser storage: ${Math.round(estimate.usage/1048576)} MB used.`:'Storage usage is not reported by this browser.';
  }
  const openSettings=()=>{ $('#settingsOverlay').hidden=false;void loadHistorySettings();void refreshDeviceStorage().catch(error=>settingsStatus(`Could not read app storage: ${error.message}`)) };
  $('#advancedSettingsButton').addEventListener('click',openSettings);
  $('#connectionSettingsFromModal').addEventListener('click',()=>{ if(nativeApp)return;$('#settingsOverlay').hidden=true;$('#connectionPanel').hidden=false;$('#connectionToggle').setAttribute('aria-expanded','true');serverInput.focus() });
  document.querySelectorAll('[data-dismiss-settings]').forEach(button=>button.addEventListener('click',()=>$('#settingsOverlay').hidden=true));
  $('#settingsOverlay').addEventListener('click',event=>{if(event.target===$('#settingsOverlay'))$('#settingsOverlay').hidden=true});
  async function loadHistorySettings(){if(!nativeApp&&!navigator.onLine){settingsStatus('History settings need a server connection.');return}try{const saved=await api('/api/telemetry/preferences');$('#historyRetention').value=String(saved.retentionDays||0);$('#historyMinimumListen').value=String(saved.minimumListenSeconds||0);settingsStatus(nativeApp?'On-device history preferences loaded.':'History preferences loaded from your server profile.')}catch(error){settingsStatus(`Could not load history settings: ${error.message}`)}}
  $('#saveHistorySettings').addEventListener('click',async()=>{try{const saved=await api('/api/telemetry/preferences',{method:'PUT',body:JSON.stringify({retentionDays:Number($('#historyRetention').value),minimumListenSeconds:Number($('#historyMinimumListen').value)})});settingsStatus(`History settings saved · ${saved.retentionDays||0} day retention.`)}catch(error){settingsStatus(`Could not save settings: ${error.message}`)}});
  const audioFolderOption=document.createElement('div');audioFolderOption.className='settings-option';audioFolderOption.innerHTML='<span>Import audio folder<small>Save selected audio on this device for offline playback.</small></span><button id="importAudioFolderButton" type="button">Choose</button>';$('#importAudioButton').closest('.settings-option').before(audioFolderOption);
  const audioFolderInput=document.createElement('input');audioFolderInput.type='file';audioFolderInput.hidden=true;audioFolderInput.multiple=true;audioFolderInput.setAttribute('webkitdirectory','');audioFolderInput.accept='audio/*,.mp3,.m4a,.aac,.wav,.ogg,.opus,.flac,.aiff,.wma';$('#audioImportInput').before(audioFolderInput);
  $('#importAudioFolderButton').addEventListener('click',()=>audioFolderInput.click());
  $('#importAudioButton').addEventListener('click',()=>$('#audioImportInput').click());
  async function importAudioSelection(event){const files=[...(event.target.files||[])];let saved=0;for(const file of files){if(!file.type.startsWith('audio/')&&!/\.(mp3|m4a|aac|wav|ogg|opus|flac|aiff|wma)$/i.test(file.name))continue;const title=file.name.replace(/\.[^.]+$/,'');const track={title,artist:'Imported audio',source:'device-import',folder:file.webkitRelativePath?.split('/').slice(0,-1).join('/')||''};await writeAudio(trackKey(track),track,file);saved++}state.downloads=await allAudio();settingsStatus(`${saved} audio file${saved===1?'':'s'} saved on this device.`);if(state.activeView==='downloads')render();event.target.value=''}
  $('#audioImportInput').addEventListener('change',importAudioSelection);audioFolderInput.addEventListener('change',importAudioSelection);
  $('#importSpotifyButton').addEventListener('click',()=>$('#spotifyImportInput').click());
  $('#spotifyImportInput').addEventListener('change',async event=>{const file=event.target.files?.[0];if(!file)return;try{const parsed=JSON.parse(await file.text());const rows=Array.isArray(parsed)?parsed:parsed.items||parsed.tracks||parsed.library||parsed.saved_tracks||[];const tracks=rows.map(row=>{const item=row.track&&typeof row.track==='object'?row.track:row;return{title:item.title||item.name||item.trackName||row.track||'',artist:item.artist||item.artistName||row.artist||'',album:item.album||item.albumName||row.album||'',source:'spotify-import'}}).filter(track=>track.title&&track.artist);if(!tracks.length)throw new Error('No track records found in that Spotify JSON file.');if(navigator.onLine)await api('/api/library/liked/import',{method:'POST',body:JSON.stringify({tracks})});state.liked=mergeTracks(state.liked,tracks);await saveState();settingsStatus(`Imported ${tracks.length} Spotify track records. Spotify audio still plays in Spotify.`);if(state.activeView==='liked'||state.activeView==='search')render()}catch(error){settingsStatus(`Spotify import failed: ${error.message}`)}event.target.value=''});
  $('#exportBackupButton').addEventListener('click',async()=>{try{let [liked,artists,playlists]=[state.liked,state.likedArtists,state.playlists];if(navigator.onLine)[liked,artists,playlists]=await Promise.all([api('/api/library/liked'),api('/api/library/artists/liked'),api('/api/library/playlists')]);const blob=new Blob([JSON.stringify({format:'AuraAudio library backup',version:1,exportedAt:new Date().toISOString(),likedSongs:liked,likedArtists:artists,playlists},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`auralibrary-backup-${new Date().toISOString().slice(0,10)}.json`;link.click();URL.revokeObjectURL(url);settingsStatus('Library backup exported.')}catch(error){settingsStatus(`Backup failed: ${error.message}`)}});
  $('#clearImageCache').addEventListener('click',()=>{for(const url of protectedImageUrls.values())URL.revokeObjectURL(url);protectedImageUrls.clear();settingsStatus('Cached album and artist images cleared.')});
  $('#clearAppCache').addEventListener('click',async()=>{try{const keys=await caches.keys();await Promise.all(keys.filter(key=>key.startsWith('aura-autonomous-')).map(key=>caches.delete(key)));if(nativeApp)await nativeCall('cleanup',{removeAudio:false});settingsStatus('Autonomous client cache cleared. Reload to fetch fresh assets.')}catch(error){settingsStatus(`Could not clear app cache: ${error.message}`)}});
  $('#panicDownloads').addEventListener('click',async()=>{const ids=[...serverJobIds];await Promise.all(ids.map(id=>api(`/api/ytb/cancel/${encodeURIComponent(id)}`,{method:'POST'}).catch(()=>{})));serverJobIds.clear();settingsStatus(ids.length?`${ids.length} active download${ids.length===1?'':'s'} cancelled.`:'No active downloads in this client.')});
  $('#clearDeviceAudio').addEventListener('click',async()=>{if(!confirm('Remove all audio stored on this device?'))return;try{const rows=await allAudio();if(nativeApp){await nativeCall('cleanup',{removeAudio:true});const records=await nativeCall('getAllRecords');for(const key of Object.keys(records.records||{}).filter(key=>key.startsWith('audio-meta:')))await nativeCall('deleteRecord',{key})}else for(const row of rows)await deleteAudio(row.key);state.downloads=[];settingsStatus(`${rows.length} device audio file${rows.length===1?'':'s'} removed.`);await refreshDeviceStorage();if(state.activeView==='downloads')render()}catch(error){settingsStatus(`Could not clear device audio: ${error.message}`)}});
  $('#resetApp').addEventListener('click',async()=>{
    if(!confirm('Reset this client’s saved settings, likes cache, queue, and offline audio?'))return;
    try{
      if(nativeApp){
        const [records,actions]=await Promise.all([nativeCall('getAllRecords'),nativeCall('getActions')]);
        await nativeCall('cleanup',{removeAudio:true});
        for(const action of actions.actions||[])await nativeCall('deleteAction',{id:action.id});
        for(const key of Object.keys(records.records||{}))await nativeCall('deleteRecord',{key});
      }
      localStorage.clear();
      await deleteIndexedDbDatabase();
      location.reload();
    }catch(error){settingsStatus(`Could not reset local app data: ${error.message}`)}
  });
  $('#trackActionsOverlay').addEventListener('click',event=>{if(event.target===$('#trackActionsOverlay')||event.target.closest('[data-dismiss-actions]'))$('#trackActionsOverlay').hidden=true});

  $('#searchForm').addEventListener('submit', event => {
    event.preventDefault();
    void search($('#query').value);
  });
  $('#query').addEventListener('input',()=>{if($('#query').value.trim()){state.activeView='search';document.querySelectorAll('[data-view]').forEach(button=>button.classList.toggle('active',button.dataset.view==='search'))}});
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => chooseView(button.dataset.view)));
  $('#syncButton').addEventListener('click', () => void syncNow());
  $('#testServerBtn').addEventListener('click',async()=>{try{const result=await api('/api/status');showMessage(`AuraAudio API connected · ${result.version||'server online'}`);$('#syncStatus').textContent='API is reachable. Loading library…';if(state.activeView==='library')await loadLibrary()}catch(e){showMessage(`API connection failed: ${e.message}`,true);$('#syncStatus').textContent='Check the server URL, port, HTTPS certificate, and access key.'}});
  $('#jamBtn').addEventListener('click',()=>void useJam().catch(error=>showMessage(`Could not connect to Jam: ${error.message}`,true)));
  try { jamSession = JSON.parse(sessionStorage.getItem(jamStorageKey) || 'null'); } catch { jamSession = null; }
  if (jamSession?.token) jamTimer = setInterval(() => void pollJam(), 2000);
  $('#queueBtn').addEventListener('click',()=>{$('#queuePanel').hidden=!$('#queuePanel').hidden;renderQueue()});$('#closeQueue').addEventListener('click',()=>$('#queuePanel').hidden=true);$('#clearQueue').addEventListener('click',()=>{state.queue=[];state.current=-1;renderQueue()});$('#queuePlaylist').addEventListener('click',async()=>{try{if(!state.playlists.length)state.playlists=await api('/api/library/playlists');if(!state.playlists.length){showMessage('No server playlists are available.',true);return}const names=state.playlists.map((p,i)=>`${i+1}. ${p.name}`).join('\n');const choice=Number(prompt(`Add playlist to queue:\n${names}`));const playlist=state.playlists[choice-1];if(playlist){const tracks=playlist.tracks||[];state.queue.push(...tracks);renderQueue();showMessage(`${tracks.length} tracks added from ${playlist.name}.`)}}catch(e){showMessage(e.message,true)}});
  document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>{const el=document.getElementById(b.dataset.close);if(el)el.hidden=true}));
  $('#playerTitle').addEventListener('click',()=>{$('#fullPlayerOverlay').hidden=false});$('#playerCover').addEventListener('click',()=>{$('#fullPlayerOverlay').hidden=false});
  $('#fullPrev').addEventListener('click',()=>moveTrack(-1));$('#fullNext').addEventListener('click',()=>moveTrack(1));$('#fullPlay').addEventListener('click',()=>$('#playTrack').click());$('#openLyrics').addEventListener('click',()=>void openLyrics());
  $('#fullSeek').addEventListener('input',e=>{const a=$('#audio');if(a.duration)a.currentTime=e.target.value/100*a.duration});
  $('#lyricsTab').addEventListener('click',()=>void openLyrics());
  $('#audio').addEventListener('timeupdate',()=>{const a=$('#audio');$('#fullSeek').value=a.duration?a.currentTime/a.duration*100:0;$('#fullTime').textContent=`${fmtTime(a.currentTime)} / ${fmtTime(a.duration)}`;if(lyrics.length){let active=lyrics[0];for(const line of lyrics){if(line.t<=a.currentTime)active=line;else break}$('#lyricsPreview').textContent=active.text;updateLyricsDisplay(a.currentTime)}});
  $('#themeButton').addEventListener('click',()=>{const p=$('#themePanel');p.hidden=!p.hidden;document.body.classList.toggle('theme-open',!p.hidden);$('#themeButton').setAttribute('aria-expanded',String(!p.hidden))});
  $('#appBrandIcon').addEventListener('load',()=>{const saved=localStorage.getItem('aura_autonomous_theme');if(saved)applyTheme(saved)});
  document.querySelectorAll('[data-theme]').forEach(b=>b.addEventListener('click',()=>{applyTheme(b.dataset.theme);localStorage.setItem('aura_autonomous_theme',b.dataset.theme);$('#themePanel').hidden=true;document.body.classList.remove('theme-open');$('#themeButton').setAttribute('aria-expanded','false')}));
  $('#shuffleBtn').addEventListener('click',()=>{state.shuffle=!state.shuffle;$('#shuffleBtn').classList.toggle('active',state.shuffle);$('#shuffleBtn').setAttribute('aria-pressed',String(state.shuffle))});
  $('#repeatBtn').addEventListener('click',()=>{state.repeat=({off:'all',all:'one',one:'off'})[state.repeat];$('#repeatBtn').classList.toggle('active',state.repeat!=='off');$('#repeatBtn').setAttribute('aria-label',`Repeat ${state.repeat}`);$('#repeatBtn').title=`Repeat ${state.repeat}`;$('#repeatIndicator').textContent=state.repeat==='one'?'1':state.repeat==='all'?'∞':''});
  document.querySelectorAll('[data-lyrics-lines]').forEach(button=>button.addEventListener('click',()=>{state.lyricLines=Number(button.dataset.lyricsLines);document.querySelectorAll('[data-lyrics-lines]').forEach(b=>b.classList.toggle('active',b===button));updateLyricsDisplay()}));
  document.addEventListener('click',event=>{if(!$('#themePanel').hidden&&!$('#themePanel').contains(event.target)&&!$('#themeButton').contains(event.target)){ $('#themePanel').hidden=true;document.body.classList.remove('theme-open');$('#themeButton').setAttribute('aria-expanded','false')}});
  $('#prevTrack').addEventListener('click',()=>moveTrack(-1));$('#nextTrack').addEventListener('click',()=>moveTrack(1));$('#playTrack').addEventListener('click',()=>{const a=$('#audio');if(a.paused)a.play().then(()=>$('#playTrack').textContent='Ⅱ').catch(e=>showMessage(e.message,true));else{a.pause();$('#playTrack').textContent='▶'}});
  $('#audio').addEventListener('timeupdate',()=>{$('#seekTrack').value=$('#audio').duration?$('#audio').currentTime/$('#audio').duration*100:0;$('#currentTime').textContent=fmtTime($('#audio').currentTime);$('#totalTime').textContent=fmtTime($('#audio').duration)});$('#audio').addEventListener('ended',()=>moveTrack(1));$('#seekTrack').addEventListener('input',e=>{const a=$('#audio');if(a.duration)a.currentTime=e.target.value/100*a.duration});
  window.addEventListener('online', () => { setOnlineStatus(); showMessage('Connection restored. Syncing saved changes…'); void syncNow(); if (state.activeView === 'discover') void loadDiscovery(); if(state.activeView==='library')void loadLibrary(); });
  window.addEventListener('offline', () => { setOnlineStatus(); showMessage('Offline mode. Likes and searches from saved music remain available.'); render(); });
  window.addEventListener('storage', event => { if (event.key === jwtKey) void syncNow(); });

  async function start() {
    serverInput.value = localStorage.getItem(serverKey) || (location.hostname === 'localhost' ? '' : location.origin);
    localStorage.removeItem('aura_autonomous_access_key');
    if(nativeApp&&!nativeStorage){showMessage('Secure on-device storage is unavailable. Update or reinstall the autonomous app.',true);$('#syncStatus').textContent='Local storage plugin could not be loaded.';return}
    const pairingCode = new URLSearchParams(location.search).get('pair');
    if (!nativeApp&&pairingCode) {
      try {
        localStorage.setItem(serverKey, location.origin);
        serverInput.value = location.origin;
        const response = await fetch(`${location.origin}/api/mobile/pairing/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: pairingCode }),
          cache: 'no-store',
          signal: AbortSignal.timeout(10000)
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.accessToken) throw new Error(result.message || `Pairing failed (${response.status}).`);
        localStorage.setItem(pairedTokenKey, result.accessToken);
        history.replaceState(null, '', `${location.pathname}${location.hash}`);
        showMessage('Phone paired securely with this server.');
      } catch (error) {
        $('#connectionPanel').hidden = false;
        showMessage(`Could not pair this phone: ${error.message}`, true);
      }
    }
    setOnlineStatus();
    if (!nativeApp&&location.hostname !== 'localhost' && !localStorage.getItem(pairedTokenKey)) {
      $('#connectionPanel').hidden = false;
      $('#connectionToggle').setAttribute('aria-expanded', 'true');
      if (!pairingCode) showMessage('Scan a Pair mobile QR from the server or its autonomous-client launcher to connect this phone.', true);
    }
    const theme=localStorage.getItem('aura_autonomous_theme');if(theme)applyTheme(theme);
    try { await migrateLegacyIndexedDb();await loadSavedState();state.downloads=await allAudio() }
    catch (error) { showMessage(`${nativeApp?'App-private storage':'Offline storage'} is unavailable: ${error.message}`, true);$('#syncStatus').textContent='Local data could not be loaded; existing data has been preserved.';return }
    render();
    if(nativeApp){
      $('#syncStatus').textContent='On-device library ready. Desktop server and QR sync are optional.';
      showMessage('Standalone mode ready. Your library and imported audio are stored privately on this device.');
    }else if (navigator.onLine && baseUrl()) {
      try { await syncNow(); } catch {}
      await loadDiscovery();
    } else if (!baseUrl()) {
      showMessage('Set your server URL in connection settings to load live discovery.');
    } else if (!navigator.onLine) {
      showMessage('Offline mode. Likes and searches from saved music remain available.');
    }
  }

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('./service-worker.js', { scope: './' }).catch(error => console.warn('[Autonomous mobile] Service worker registration failed:', error));
  }
  void start();
})();
