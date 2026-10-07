# Folio

A mobile-first document scanner that runs in the browser. Point the camera at a page, adjust the four corners, then export a straightened multi-page PDF.

## Run

```bash
npm install
npm run dev
```

Open the URL Vite prints. The camera needs `localhost` or HTTPS. The first scan downloads OpenCV.js (about 8 MB) and keeps it for the rest of the session.

```bash
npm run build
npm run preview
```

## Pipeline

1. Capture from the rear camera, or upload a photo.
2. Detect the page contour and let you drag the four corners. A magnifier follows the pin.
3. `jscanify` warps the quadrilateral into a straight rectangle (OpenCV.js is the fallback).
4. Choose Magic Color, black & white, or the original straightened photo.
5. Add more pages, reorder or delete them, then export one PDF or the JPEGs.

Pages stay in the tab until you export or refresh.
