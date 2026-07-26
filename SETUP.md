# Amazon Bulk Auto-Ungate Checker — Setup Guide

## How This Works

This tool connects directly to your Amazon Seller Central account via Amazon's official **Selling Partner API (SP-API)** — the same API that Boxem, SellerAmp, and other tools use. It calls the `getListingsRestrictions` endpoint for each ASIN to check if you're gated or ungated.

**Result:** Paste 1,000 ASINs → get back a list of which ones you can sell, in minutes. Fully automated.

---

## One-Time Setup (15 minutes)

You need 3 things from your Seller Central account:

| Credential | What It Is |
|---|---|
| **Client ID** | Identifies your app to Amazon |
| **Client Secret** | Your app's password |
| **Refresh Token** | Lets the tool access YOUR seller data |

### Step 1: Register as a Developer

1. Go to **Seller Central** → **Partner Network** → **Develop Apps**
   - Direct link: https://sellercentral.amazon.com/sellingpartner/developerconsole
2. If prompted, click **Register** to become a developer
3. Fill in the form:
   - **Organization name**: Your business name
   - **Use case**: Select "I want to integrate Amazon's APIs into my own systems to manage my selling business"
   - **Data access**: Select the roles needed (select all to be safe)
4. Agree to the policies and submit
5. Wait for approval (usually instant for private/self-use apps)

### Step 2: Create Your App

1. In **Develop Apps**, click **Add new app client**
2. Fill in:
   - **App name**: "My Ungate Checker" (anything you want)
   - **API type**: SP API
   - **Roles**: Select all available
3. Click **Save and exit**
4. You'll see your **Client ID** and **Client Secret** — copy both!

### Step 3: Self-Authorize & Get Refresh Token

1. Find your app in the list
2. Click the dropdown arrow next to **Edit App** → click **Authorize**
3. Click **Authorize app**
4. **COPY THE REFRESH TOKEN** that appears — you only see it once!

### Step 4: Get Your Seller ID

1. Go to **Seller Central** → **Settings** → **Account Info**
2. Your **Merchant Token** / **Seller ID** is on this page (format: `A1B2C3D4E5F6G7`)

### Step 5: Configure the Tool

Create the config file by running:
```bash
cd "/Users/ethanwerner/Downloads/Amazon Product Finder"
cp .env.example .env
```

Then edit `.env` and paste your credentials.

---

## Usage

```bash
# Install dependencies (one time)
npm install

# Check ASINs from a file
node checker.js asins.txt

# Check ASINs from Keepa CSV export
node checker.js keepa-export.csv

# Check specific ASINs inline
node checker.js B08N5WRWNW B07XJ8C8F5 B09GK3N1ML

# Results are saved to results/ folder
```

That's it! The tool does the rest automatically.
