# Deploying to Railway

## Prerequisites
1. Python pipeline already run locally (`collect_pro.py` → `features.py` → `train.py`)
2. `data/processed/` CSVs exist on disk
3. Node.js installed
4. Railway CLI installed: `npm install -g @railway/cli`

## Step 1 — Test locally first
```powershell
npm install
node server.js
```
Open http://127.0.0.1:30002/calculator.html and test with your PUUID.

## Step 2 — Push to GitHub
```powershell
git init
git add .
git commit -m "TFT Coach initial commit"
# Create a repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/tft-coach.git
git push -u origin main
```

## Step 3 — Deploy to Railway
```powershell
railway login
railway init
railway up
```

## Step 4 — Set environment variables
```powershell
railway variable set RIOT_API_KEY="RGAPI-your-key"
railway variable set GEMINI_API_KEY="your-gemini-key"
railway variable set GEMINI_MODEL="gemini-2.5-flash"
railway variable set GROQ_API_KEY="gsk_your-groq-key"
```

Get your Gemini key free at: https://aistudio.google.com/app/apikey
Get your Groq key free at: https://console.groq.com/keys

## Step 5 — Redeploy and get URL
```powershell
railway up
railway domain
```

Your app will be live at `https://tft-coach-xxxx.up.railway.app`
