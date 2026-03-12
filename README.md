# Geo spreadsheet uploader

CLI importer for taking the provided Google Sheet and publishing its rows into a Geo personal space on testnet.

It uses:

- [`@geoprotocol/geo-sdk`](https://github.com/geobrowser/geo-sdk/blob/main/README.md) to create properties, a type, entities, image covers, and a publishable Geo edit
- the Geo testnet GraphQL API to look up existing properties, types, and entities before building the edit

## What it imports

The importer is preconfigured for this sheet:

- Source sheet: `https://docs.google.com/spreadsheets/d/1ujReXRQdDiv7NFw40zuVHqhn2tlinj_B3kwj6ynhWxA/edit?gid=0#gid=0`
- CSV export used by default:
  `https://docs.google.com/spreadsheets/d/1ujReXRQdDiv7NFw40zuVHqhn2tlinj_B3kwj6ynhWxA/export?format=csv&gid=0`

Each row becomes a Geo entity with:

- `name` <- `Name`
- `description` <- `Description`
- cover image <- `Avatar` URL when Geo can fetch the image
- custom text properties:
  - `Website`
  - `X`
  - `Avatar URL`
  - `Native Tokens`
  - `Blockchains`
  - `Topics`

By default the importer creates or reuses a Geo type called `Spreadsheet Entry`.

## Setup

```bash
npm install
cp .env.example .env
```

Set `GEO_PRIVATE_KEY` in `.env` to the private key exported from your Geo wallet:

- export wallet: `https://www.geobrowser.io/export-wallet`

## Usage

### Dry-run without publishing

This parses the sheet and prepares the Geo ops locally:

```bash
npm run import -- --dry-run
```

### Dry-run against an existing space

If you want duplicate detection without exposing a private key, pass a known space ID:

```bash
npm run import -- --space-id <space-id> --dry-run
```

### Publish to your Geo personal space

This uses the Geo smart-account flow on testnet:

```bash
npm run import -- --publish
```

## Important behavior

- The importer expects your Geo smart account to already have a personal space.
- Existing entities are matched by `Name` within the configured type.
- Default existing-entity behavior is `upsert`:
  - existing rows are updated
  - missing rows are created
- You can change that behavior with:

```bash
npm run import -- --existing-mode skip --dry-run
npm run import -- --existing-mode error --dry-run
```

## Useful options

```bash
npm run import -- --help
```

Key flags:

- `--csv <path>`: import a local CSV instead of the default Google Sheet
- `--sheet-url <url>`: override the sheet CSV URL
- `--type-name <name>`: change the Geo type name
- `--edit-name <name>`: change the publish edit label
- `--max-rows <n>`: limit rows for testing
- `--graphql-endpoint <url>`: override the Geo GraphQL endpoint

## Verification performed in this repo

The importer has been checked with:

- `npm run check`
- `npm run import -- --dry-run --max-rows 3`
- `npm run import -- --dry-run --space-id 003eaa9b7a56fa847afd6f2e8cc518a6 --max-rows 3`
