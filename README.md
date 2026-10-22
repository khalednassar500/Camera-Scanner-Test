# Camera Scanner Test

A small standalone page for testing the POS **camera barcode scanner** on a
phone. It uses the same scanning engine and defaults as the POS register
(read area, 1080p, two matching reads per scan, same-item gap). Nothing is
uploaded: decoding happens in the phone's browser.

This folder is temporary and separate from the POS: deploy it, test, then delete it.

## Deploy to Vercel (free)

The camera only works on **https**, which Vercel gives you automatically.

### Option A — from your computer (quickest)

```bash
cd camera-scanner-test
npm install
npx vercel          # log in / sign up when asked, accept the defaults
npx vercel --prod   # gives you the public https link
```

### Option B — from GitHub

1. Create a new GitHub repository and push this folder to it.
2. On vercel.com → **Add New… → Project** → import the repository.
3. Vercel detects **Vite** automatically (build `npm run build`, output `dist`). Click **Deploy**.

## Test on your phone

1. Open the Vercel link on the phone (Chrome on Android, Safari on iPhone).
2. Tap **Start camera** and allow camera access. The back camera is used by default.
3. Hold each product's barcode inside the box. Each scan beeps/vibrates and is added to the log.
4. Watch **Decode time** and **Seen → counted** to see how fast it is.
5. If a product never reads: keep it in the box and tap **Save frame**, then send me the image.

**Test settings** let you compare the built-in decoder with ZXing (what iPhones and
Windows use), change how many reads confirm a scan, decode the whole picture,
and change the camera resolution. On Android phones that support it you also get
**Flashlight** and **Zoom**.

## Run locally (optional)

```bash
npm install
npm run dev
```

The camera works on `http://localhost` on the same computer. A phone on your
Wi-Fi needs https, so use the Vercel link for phones.

## Remove

Delete the Vercel project (Project → Settings → Delete) and this folder.
# Camera-Scanner-Test
