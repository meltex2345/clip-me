# Clip Me

Free, browser-based video clipping. Upload a local video or import a direct public video file link, then preview and export a WebM clip.

## Use the website

Open [Clip Me](https://meltex2345.github.io/clip-me/), upload a video from your device or paste a direct public MP4, WebM, or MOV URL. Select the clip range and layout, then choose **Export my clip**.

YouTube, TikTok, and other watch-page links are not direct video files and are not supported. The link importer accepts public video files up to 500 MB. Editing stays in your browser; link imports pass through the importer service. The free server may sleep when idle, so its first import after a while can take about a minute.

## Deploy the link importer

This repository includes `render.yaml` for a free Render web service. In Render, create a new Blueprint and connect this repository; Render reads the blueprint and creates the importer service. The expected service URL is `https://clip-me-import-meltex2345.onrender.com`.

The importer needs Node.js and uses only built-in modules. Its `/health` endpoint is used for deployment health checks. Set `ALLOWED_ORIGIN` to the public website origin if you change the GitHub Pages owner or repository.

## Local development

Install Node.js 18 or newer, then run `start-server.bat` from this folder. Open http://127.0.0.1:4173. To allow the production website when running a local importer, use the deployed importer URL configured in `index.html`.
