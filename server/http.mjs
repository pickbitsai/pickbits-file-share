// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
export function nodeHandler(handler, { origin, maxBytes = 1024 ** 3 + 1024 ** 2 } = {}) {
  return async (req, res) => {
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > maxBytes) { res.writeHead(413); res.end('Request too large'); return; } chunks.push(chunk); }
      const body = Buffer.concat(chunks);
      const response = await handler(new Request(`${origin || `http://${req.headers.host}`}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }));
      const headers = Object.fromEntries(response.headers); const cookies = response.headers.getSetCookie(); if (cookies.length) headers['set-cookie'] = cookies;
      res.writeHead(response.status, headers); res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"Server unavailable"}'); }
  };
}
