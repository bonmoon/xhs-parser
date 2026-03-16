export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url } = req.method === 'POST' ? req.body : req.query;
  if (!url) return res.status(400).json({ error: '缺少 url 参数' });

  try {
    const urlMatch = url.match(/https?:\/\/[^\s，,。！]+/);
    const rawUrl = urlMatch ? urlMatch[0].trim() : url.trim();

    let noteId = extractNoteId(rawUrl);

    if (!noteId) {
      const resolved = await resolveShortUrl(rawUrl);
      noteId = extractNoteId(resolved);
    }

    if (!noteId) {
      return res.status(400).json({ error: '无法解析笔记 ID，请确认链接有效' });
    }

    const noteData = await fetchNote(noteId);
    return res.status(200).json(noteData);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || '解析失败，请重试' });
  }
}

function extractNoteId(url) {
  if (!url) return null;
  const patterns = [
    /\/explore\/([a-fA-F0-9]{24})/,
    /\/discovery\/item\/([a-fA-F0-9]{24})/,
    /noteId=([a-fA-F0-9]{24})/,
    /item\/([a-fA-F0-9]{24})/,
    /\/([a-fA-F0-9]{24})(?:[/?#]|$)/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

async function resolveShortUrl(url) {
  try {
    const r = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': 'https://www.xiaohongshu.com/',
      },
    });
    const finalUrl = r.url;
    const html = await r.text();
    const canonicalMatch = html.match(/canonical['"]\s+href=['"]([^'"]+)['"]/i)
      || html.match(/og:url['"]\s+content=['"]([^'"]+)['"]/i);
    if (canonicalMatch) return canonicalMatch[1];
    return finalUrl;
  } catch {
    return url;
  }
}

async function fetchNote(noteId) {
  const url = `https://www.xiaohongshu.com/explore/${noteId}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Referer': 'https://www.xiaohongshu.com/',
    'Cookie': process.env.XHS_COOKIE || '',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-origin',
  };

  const r = await fetch(url, { headers });
  const html = await r.text();

  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]+?\})\s*(?:<\/script>|;(?:window|var|\(function))/);
  if (stateMatch) {
    try {
      const json = stateMatch[1].replace(/:\s*undefined/g, ':null').replace(/\bundefined\b/g, 'null');
      const state = JSON.parse(json);
      const note = findNote(state, noteId);
      if (note) return buildResult(note, noteId);
    } catch (e) {
      console.log('state parse error:', e.message);
    }
  }

  const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
  if (nextMatch) {
    try {
      const data = JSON.parse(nextMatch[1]);
      const note = deepFindNote(data, noteId);
      if (note) return buildResult(note, noteId);
    } catch (e) {
      console.log('next data parse error:', e.message);
    }
  }

  // Fallback: extract media URLs directly from HTML
  const images = [];
  const imgRe = /https:\/\/sns-img-[a-z]+\.xhscdn\.com\/[a-zA-Z0-9_\-\/!@.?=&%]+/g;
  let m;
  while ((m = imgRe.exec(html)) !== null) {
    const u = m[0].split('"')[0].split("'")[0];
    if (!images.includes(u) && !u.includes('avatar') && !u.includes('emoji')) {
      images.push(u);
    }
  }

  const videoRe = /https:\/\/sns-video-[a-z]+\.xhscdn\.com\/[a-zA-Z0-9_\-\/!@.?=&%]+\.mp4[^"'\s]*/g;
  const videos = [];
  while ((m = videoRe.exec(html)) !== null) {
    const u = m[0].split('"')[0].split("'")[0];
    if (!videos.includes(u)) videos.push(u);
  }

  if (images.length > 0 || videos.length > 0) {
    return {
      noteId,
      title: '',
      type: videos.length > 0 ? 'video' : 'image',
      images: images.slice(0, 20),
      video: videos[0] || null,
      cover: images[0] || null,
    };
  }

  throw new Error('无法获取笔记内容，笔记可能需要登录或已被删除');
}

function findNote(state, noteId) {
  const maps = ['noteDetailMap', 'noteMap', 'note'];
  for (const key of maps) {
    const m = state[key] || (state.note && state.note[key]);
    if (m && m[noteId]) return m[noteId].note || m[noteId];
  }
  return deepFindNote(state, noteId);
}

function deepFindNote(obj, noteId, depth = 0) {
  if (depth > 6 || !obj || typeof obj !== 'object') return null;
  if ((obj.noteId === noteId || obj.id === noteId) && (obj.imageList || obj.video || obj.images)) return obj;
  for (const v of Object.values(obj)) {
    if (typeof v === 'object') {
      const r = deepFindNote(v, noteId, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

function buildResult(note, noteId) {
  const result = {
    noteId,
    title: note.title || note.desc || '',
    type: 'image',
    images: [],
    video: null,
    cover: null,
  };

  const video = note.video || note.videoInfo;
  if (video) {
    result.type = 'video';
    const streams = video?.media?.stream;
    const url = streams?.h264?.[0]?.masterUrl
      || streams?.av1?.[0]?.masterUrl
      || streams?.h265?.[0]?.masterUrl
      || video?.consumer?.originVideoKey
      || video?.url
      || null;
    if (url) result.video = url.startsWith('http') ? url : `https://sns-video-bd.xhscdn.com/${url}`;
    const coverId = video?.image?.firstFrameInfo?.imageId || video?.coverInfo?.imageId;
    if (coverId) result.cover = `https://sns-img-bd.xhscdn.com/${coverId}`;
  }

  const imgList = note.imageList || note.images || [];
  if (imgList.length > 0 && result.type === 'image') {
    result.images = imgList.map(img => {
      const id = img.traceId || img.imageId || img.infoList?.[0]?.imageId;
      if (id) return `https://sns-img-bd.xhscdn.com/${id}`;
      return img.urlDefault || img.url || img.infoList?.[0]?.url || '';
    }).filter(Boolean);
    if (!result.cover) result.cover = result.images[0] || null;
  }

  return result;
}
