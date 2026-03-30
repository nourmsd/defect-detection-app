// Use the current host to automatically connect locally or over Wi-Fi
const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
export const environment = {
  production: false,
  apiUrl: `http://${host}:5000/api`,
  socketUrl: `http://${host}:5000`
};
