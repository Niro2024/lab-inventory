// The app talks to the lab server it is served from (server/server.py).
// Opened anywhere else (or with ?mock=1) it runs in demo mode: data stays in this browser only.
export const CONFIG = {
  // Address printed into the shelf QR codes: the fixed GitHub Pages front door (docs/index.html),
  // which forwards to the server's current tunnel address. Empty = the address the app is opened from.
  PUBLIC_URL: 'https://niro2024.github.io/lab-inventory/',
};
