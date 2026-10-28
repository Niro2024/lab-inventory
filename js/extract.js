// Label photo -> fields, via the lab server's /api/extract-label (the AI key stays on the server).
// In demo/mock mode a stub returns the recorded answer for the test fixtures.

// Downscale to keep uploads and AI calls small (labels stay readable at 1600 px).
export async function toJpeg(file, max = 1600) {
  const img = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
}

const toBase64 = blob => new Promise(res => {
  const fr = new FileReader();
  fr.onload = () => res(String(fr.result).split(',')[1]);
  fr.readAsDataURL(blob);
});

export async function extractLabel(file, { mock }) {
  if (mock) {
    const base = String(file.name || '').replace(/\.[^.]+$/, '');
    const r = await fetch(`tests/fixtures/labels/${encodeURIComponent(base)}.json`);
    return r.ok ? (await r.json()).expected : {};
  }
  const jpeg = await toJpeg(file);
  const r = await fetch('api/extract-label', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: await toBase64(jpeg), media_type: 'image/jpeg' }),
  });
  const out = await r.json().catch(() => null);
  if (!r.ok || !out) throw new Error(`server error ${r.status}`);
  if (out.error) throw new Error(String(out.error).slice(0, 200));
  return out;
}
