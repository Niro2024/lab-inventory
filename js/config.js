// The app talks to the lab server it is served from (server/server.py).
// Opened anywhere else (or with ?mock=1) it runs in demo mode: data stays in this browser only.
export const CONFIG = {
  // Address printed into the shelf QR codes, e.g. a tunnel address like 'https://lab-inventory.example.org/'.
  // Empty = use the address the app is currently opened from.
  PUBLIC_URL: '',
};
