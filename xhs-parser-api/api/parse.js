// Xiaohongshu (RedNote) media parser API
// Deploy to Vercel as serverless function

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { url } = req.method === 'POST' ? req.body : req.query;

  if (!url) {
    return res.status(400).json({ error: '缺少 url 参数' });
  }

  try {
    // Step 1: Resolve short URL to get real note URL
    const realUrl = await resolveUrl(url);
    console.log('Resolved URL:', realUrl);

    // Step 2: Extract note ID from URL
    const noteId = extractNoteId(realUrl);
    if (!noteId) {
      return res.status(400).json({ error: '无法解析笔记 ID，请确认链接有效' });
    }

    // Step 3: Fetch note data
    const noteData = await fetchNoteData(noteId, realUrl);

    return res.status(200).json(noteData);
  } catch (err) {
    console.error('Parse error:', err.message);
    return res.status(500).json({ error: err.message || '解析失败，请重试' });
  }
}

async function resolveUrl(url) {
  // Extract URL from share text if needed
  const urlMatch = url.match(/https?:\/\/[^\s，,]+/);
  const cleanUrl = urlMatch ? urlMatch[0] : url.trim();

  try {
    const response = await fetch(cleanUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.0',
      },
    });
    return response.url || cleanUrl;
  } catch {
    return cleanUrl;
  }
}

function extractNoteId(url) {
  // Match patterns like /explore/noteId or /discovery/item/noteId
  const patterns = [
    /\/explore\/([a-fA-F0-9]{24})/,
    /\/discovery\/item\/([a-fA-F0-9]{24})/,
    /noteId=([a-fA-F0-9]{24})/,
    /\/([a-fA-F0-9]{24})(?:\?|$)/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

async function fetchNoteData(noteId, refUrl) {
  // Use XHS web API
  const apiUrl = `https://www.xiaohongshu.com/explore/${noteId}`;

  const headers = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Referer': 'https://www.xiaohongshu.com/',
  };

  const response = await fetch(apiUrl, { headers });
  const html = await response.text();

  // Extract __INITIAL_STATE__ from the page
  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{.+?\})\s*(?:<\/script>|;window)/s);
  if (!stateMatch) {
    throw new Error('无法获取笔记数据，可能需要登录或笔记已删除');
  }

  let state;
  try {
    // Replace undefined values for JSON parse
    const jsonStr = stateMatch[1]
      .replace(/:\s*undefined/g, ': null')
      .replace(/\bundefined\b/g, 'null');
    state = JSON.parse(jsonStr);
  } catch {
    throw new Error('数据解析失败');
  }

  // Navigate the state object to find note data
  const noteDetail = findNoteDetail(state, noteId);
  if (!noteDetail) {
    throw new Error('未找到笔记内容');
  }

  return extractMedia(noteDetail, noteId);
}

function findNoteDetail(state, noteId) {
  // Try common paths
  const paths = [
    ['noteDetailMap', noteId, 'note'],
    ['note', 'noteDetailMap', noteId],
  ];

  for (const path of paths) {
    let obj = state;
    for (const key of path) {
      obj = obj?.[key];
      if (!obj) break;
    }
    if (obj) return obj;
  }

  // Deep search
  return deepSearch(state, noteId);
}

function deepSearch(obj, noteId, depth = 0) {
  if (depth > 5 || !obj || typeof obj !== 'object') return null;

  if (obj.noteId === noteId || obj.id === noteId) {
    if (obj.imageList || obj.video) return obj;
  }

  for (const val of Object.values(obj)) {
    if (typeof val === 'object') {
      const found = deepSearch(val, noteId, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function extractMedia(note, noteId) {
  const result = {
    noteId,
    title: note.title || note.desc || '无标题',
    type: 'unknown',
    images: [],
    video: null,
    cover: null,
  };

  // Check for video
  if (note.video) {
    result.type = 'video';
    const videoInfo = note.video;

    // Try to get highest quality stream
    const streamUrl =
      videoInfo?.media?.stream?.h264?.[0]?.masterUrl ||
      videoInfo?.media?.stream?.av1?.[0]?.masterUrl ||
      videoInfo?.consumer?.originVideoKey ||
      null;

    if (streamUrl) {
      result.video = streamUrl.startsWith('http') ? streamUrl : `https://sns-video-bd.xhscdn.com/${streamUrl}`;
    }

    // Cover image
    const coverKey = videoInfo?.image?.firstFrameInfo?.imageId || note.imageList?.[0]?.traceId;
    if (coverKey) {
      result.cover = `https://sns-img-bd.xhscdn.com/${coverKey}?imageView2/2/w/1080/format/jpg`;
    }
  }

  // Images
  if (note.imageList && note.imageList.length > 0) {
    if (result.type === 'unknown') result.type = 'image';

    result.images = note.imageList.map((img) => {
      // Get original/watermark-free URL
      const traceId = img.traceId || img.imageId;
      if (traceId) {
        // Original quality without watermark
        return `https://sns-img-bd.xhscdn.com/${traceId}?imageView2/2/w/1080/format/jpg`;
      }
      // Fallback
      return img.urlDefault || img.url || '';
    }).filter(Boolean);
  }

  return result;
}
