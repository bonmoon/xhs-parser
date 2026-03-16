// Xiaohongshu media parser - Mobile API approach

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url } = req.method === 'POST' ? req.body : req.query;
  if (!url) return res.status(400).json({ error: '缺少 url 参数' });

  try {
    const rawUrl = extractRawUrl(url);
    const finalUrl = await followRedirects(rawUrl);
    console.log('Final URL:', finalUrl);

    let noteId = extractNoteId(finalUrl);
    if (!noteId) return res.status(400).json({ error: '无法解析笔记 ID', finalUrl });

    console.log('Note ID:', noteId);

    // Try mobile API first
    const result = await fetchViaMobileApi(noteId);
    return res.status(200).json(result);

  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: err.message });
  }
}

function extractRawUrl(text) {
  const m = text.match(/https?:\/\/[^\s\u3000，,。！!？?]+/);
  return m ? m[0] : text.trim();
}

async function followRedirects(url, max = 10) {
  let current = url;
  for (let i = 0; i < max; i++) {
    try {
      const r = await fetch(current, {
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15' }
      });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        if (!loc) break;
        current = loc.startsWith('http') ? loc : new URL(loc, current).href;
        continue;
      }
      break;
    } catch { break; }
  }
  return current;
}

function extractNoteId(url) {
  const patterns = [
    /xiaohongshu\.com\/explore\/([a-fA-F0-9]{24})/,
    /xiaohongshu\.com\/discovery\/item\/([a-fA-F0-9]{24})/,
    /[?&]noteId=([a-fA-F0-9]{24})/,
    /\/([a-fA-F0-9]{24})(?:[?&#]|$)/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m && m[1].length >= 20) return m[1];
  }
  return null;
}

async function fetchViaMobileApi(noteId) {
  // Use XHS SNS API (no auth required for public notes)
  const apiUrl = `https://www.xiaohongshu.com/api/sns/web/v1/feed`;
  
  const body = JSON.stringify({
    source_note_id: noteId,
    image_formats: ['jpg', 'webp', 'avif'],
    extra: { need_body_topic: '1' },
    xsec_source: 'pc_feed',
    xsec_token: '',
  });

  const cookie = process.env.XHS_COOKIE || '';

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': `https://www.xiaohongshu.com/explore/${noteId}`,
      'Origin': 'https://www.xiaohongshu.com',
      'Cookie': cookie,
      'x-s': '',
      'x-t': '',
    },
    body,
  });

  const data = await response.json();
  console.log('API response code:', data.code);

  if (data.code === 0 && data.data?.items?.length > 0) {
    return parseApiResponse(data.data.items[0], noteId);
  }

  // Fallback: try oembed / share API
  return await fetchViaShareApi(noteId);
}

async function fetchViaShareApi(noteId) {
  // Try the public share endpoint
  const url = `https://www.xiaohongshu.com/discovery/item/${noteId}`;
  const cookie = process.env.XHS_COOKIE || '';

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Cookie': cookie,
    },
  });

  const html = await res.text();

  // Try to extract initial state
  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*(?:<\/script>|;\s*window)/);
  if (stateMatch) {
    try {
      const jsonStr = stateMatch[1].replace(/:\s*undefined/g, ':null').replace(/\bundefined\b/g, 'null');
      const state = JSON.parse(jsonStr);
      const note = findNoteInState(state, noteId);
      if (note) return extractMedia(note, noteId);
    } catch(e) { console.log('state parse error:', e.message); }
  }

  // Try to extract from meta tags (public info)
  return extractFromMeta(html, noteId);
}

function parseApiResponse(item, noteId) {
  const note = item.note_card || item;
  const result = {
    noteId,
    title: note.title || note.desc || '无标题',
    type: 'unknown',
    images: [],
    video: null,
    cover: null,
  };

  if (note.video) {
    result.type = 'video';
    const v = note.video;
    result.video = v.media?.stream?.h264?.[0]?.master_url
                || v.media?.stream?.h264?.[0]?.backup_urls?.[0]
                || v.consumer?.origin_video_key
                || null;
    if (result.video && !result.video.startsWith('http')) {
      result.video = `https://sns-video-bd.xhscdn.com/${result.video}`;
    }
    const coverKey = v.image?.first_frame_fileid || note.image_list?.[0]?.trace_id;
    if (coverKey) result.cover = `https://sns-img-bd.xhscdn.com/${coverKey}`;
  }

  const imageList = note.image_list || note.imageList || [];
  if (imageList.length > 0) {
    if (result.type === 'unknown') result.type = 'image';
    result.images = imageList.map(img => {
      const id = img.trace_id || img.traceId || img.file_id || img.fileId;
      if (id) return `https://sns-img-bd.xhscdn.com/${id}?imageView2/2/w/1080/format/jpg`;
      return img.url_default || img.urlDefault || img.url || '';
    }).filter(Boolean);
  }

  return result;
}

function findNoteInState(state, noteId) {
  const candidates = [
    state?.noteDetailMap?.[noteId]?.note,
    state?.note?.noteDetailMap?.[noteId],
    state?.noteDetailMap?.[noteId],
  ].filter(Boolean);
  if (candidates.length) return candidates[0];
  return deepSearch(state, noteId, 0);
}

function deepSearch(obj, noteId, depth) {
  if (depth > 6 || !obj || typeof obj !== 'object') return null;
  if ((obj.noteId === noteId || obj.id === noteId) && (obj.imageList || obj.video)) return obj;
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object') {
      const r = deepSearch(val, noteId, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

function extractMedia(note, noteId) {
  const result = { noteId, title: note.title || note.desc || '无标题', type: 'unknown', images: [], video: null, cover: null };
  if (note.video) {
    result.type = 'video';
    const v = note.video;
    const streamUrl = v?.media?.stream?.h264?.[0]?.masterUrl || v?.media?.stream?.h264?.[0]?.master_url || v?.consumer?.originVideoKey || null;
    if (streamUrl) result.video = streamUrl.startsWith('http') ? streamUrl : `https://sns-video-bd.xhscdn.com/${streamUrl}`;
    const coverKey = v?.image?.firstFrameInfo?.imageId || note.imageList?.[0]?.traceId;
    if (coverKey) result.cover = `https://sns-img-bd.xhscdn.com/${coverKey}?imageView2/2/w/1080/format/jpg`;
  }
  if (note.imageList?.length > 0) {
    if (result.type === 'unknown') result.type = 'image';
    result.images = note.imageList.map(img => {
      const id = img.traceId || img.imageId;
      return id ? `https://sns-img-bd.xhscdn.com/${id}?imageView2/2/w/1080/format/jpg` : (img.urlDefault || img.url || '');
    }).filter(Boolean);
  }
  return result;
}

function extractFromMeta(html, noteId) {
  // Extract what we can from og tags as last resort
  const title = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1] || '无标题';
  const image = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)?.[1];
  const video = html.match(/<meta[^>]+property="og:video"[^>]+content="([^"]+)"/i)?.[1];

  if (!image && !video) {
    throw new Error('笔记需要登录才能查看，请检查 Cookie 是否有效');
  }

  return {
    noteId,
    title,
    type: video ? 'video' : 'image',
    images: image ? [image] : [],
    video: video || null,
    cover: image || null,
  };
}
