import "dotenv/config";

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  Graph,
  SystemIds,
  TESTNET_RPC_URL,
  getSmartAccountWalletClient,
  personalSpace,
  type Op,
} from "@geoprotocol/geo-sdk";
import { SpaceRegistryAbi } from "@geoprotocol/geo-sdk/abis";
import { TESTNET } from "@geoprotocol/geo-sdk/contracts";
import { parse } from "csv-parse/sync";
import { createPublicClient, http, type Hex } from "viem";

const DEFAULT_SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1ujReXRQdDiv7NFw40zuVHqhn2tlinj_B3kwj6ynhWxA/export?format=csv&gid=0";
const DEFAULT_GRAPHQL_ENDPOINT = "https://testnet-api.geobrowser.io/graphql";
const DEFAULT_TYPE_NAME = "Spreadsheet Entry";
const DEFAULT_EDIT_NAME = "Import spreadsheet entries to Geo";
const NETWORK = "TESTNET" as const;

const MANAGED_PROPERTIES = [
  {
    key: "website",
    name: "Website",
    description: "Official website URL imported from the spreadsheet.",
  },
  {
    key: "x",
    name: "X",
    description: "X/Twitter profile URL imported from the spreadsheet.",
  },
  {
    key: "avatarUrl",
    name: "Avatar URL",
    description: "Avatar image URL imported from the spreadsheet.",
  },
  {
    key: "nativeTokens",
    name: "Native Tokens",
    description: "Comma-separated native tokens imported from the spreadsheet.",
  },
  {
    key: "blockchains",
    name: "Blockchains",
    description: "Comma-separated supported blockchains imported from the spreadsheet.",
  },
  {
    key: "topics",
    name: "Topics",
    description: "Comma-separated topics imported from the spreadsheet.",
  },
] as const;

type ManagedPropertyKey = (typeof MANAGED_PROPERTIES)[number]["key"];
type ExistingMode = "upsert" | "skip" | "error";

type SpreadsheetRow = {
  name: string;
  description?: string;
  website?: string;
  x?: string;
  avatar?: string;
  nativeTokens?: string;
  blockchains: string[];
  topics: string[];
};

type CliOptions = {
  csvPath?: string;
  sheetUrl: string;
  graphqlEndpoint: string;
  privateKey?: `0x${string}`;
  spaceId?: string;
  publish: boolean;
  typeName: string;
  editName: string;
  maxRows?: number;
  existingMode: ExistingMode;
};

type ExistingEntity = {
  id: string;
  name: string;
};

type ExistingGeoContext = {
  typeId?: string;
  propertiesByKey: Partial<Record<ManagedPropertyKey, string>>;
  existingEntitiesByName: Map<string, ExistingEntity>;
  warnings: string[];
};

type ImportPlan = {
  ops: Op[];
  spaceId?: string;
  typeId: string;
  createdProperties: string[];
  createdType?: string;
  createdEntities: string[];
  updatedEntities: string[];
  skippedEntities: string[];
  warnings: string[];
};

type PublisherContext = {
  smartAccount: Awaited<ReturnType<typeof getSmartAccountWalletClient>>;
  publicClient: ReturnType<typeof createPublicClient>;
  smartAccountAddress: `0x${string}`;
  spaceId: string;
};

const HELP_TEXT = `Geo spreadsheet uploader

Usage:
  npm run import -- [options]

Options:
  --sheet-url <url>         Google Sheet CSV export URL
  --csv <path>              Import from a local CSV file instead
  --space-id <uuid>         Existing Geo space ID for dry-runs without a private key
  --private-key <hex>       Geo exported private key (otherwise use GEO_PRIVATE_KEY)
  --type-name <name>        Geo type name to create/use (default: "${DEFAULT_TYPE_NAME}")
  --edit-name <name>        Geo edit label (default: "${DEFAULT_EDIT_NAME}")
  --graphql-endpoint <url>  Geo GraphQL endpoint
  --max-rows <n>            Limit rows for testing
  --existing-mode <mode>    upsert | skip | error (default: upsert)
  --publish                 Submit the edit onchain
  --dry-run                 Explicitly keep the run local (default behavior)
  --help                    Show this message

Environment variables:
  GEO_PRIVATE_KEY           Geo exported private key
  GEO_SPACE_ID              Optional space ID for dry-runs without a private key
  GEO_GRAPHQL_ENDPOINT      Optional GraphQL endpoint override

Examples:
  npm run import -- --dry-run
  npm run import -- --space-id <space-id> --dry-run
  npm run import -- --publish
`;

async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2));
    const rows = await loadRows(options);
    const sourceLabel = options.csvPath
      ? resolve(options.csvPath)
      : options.sheetUrl;

    console.log(`Loaded ${rows.length} rows from ${sourceLabel}.`);

    const duplicateNames = findDuplicateNames(rows);
    if (duplicateNames.length > 0) {
      throw new Error(
        `The source data contains duplicate Name values: ${duplicateNames.join(", ")}.`,
      );
    }

    let publisher: PublisherContext | undefined;
    let resolvedSpaceId = options.spaceId ?? normalizeOptionalSpaceId(process.env.GEO_SPACE_ID);

    if (options.privateKey) {
      publisher = await resolvePublisherContext(options.privateKey);

      if (resolvedSpaceId && resolvedSpaceId !== publisher.spaceId) {
        throw new Error(
          `Provided space ID (${resolvedSpaceId}) does not match the smart-account personal space (${publisher.spaceId}).`,
        );
      }

      resolvedSpaceId = publisher.spaceId;
      console.log(
        `Resolved smart-account address ${publisher.smartAccountAddress} with personal space ${publisher.spaceId}.`,
      );
    } else if (options.publish) {
      throw new Error(
        "Publishing requires GEO_PRIVATE_KEY or --private-key so the importer can sign the Geo edit.",
      );
    } else if (resolvedSpaceId) {
      console.log(`Using provided space context ${resolvedSpaceId} for Geo lookups.`);
    } else {
      console.log(
        "No Geo credentials or space ID were provided, so this run will assume a fresh import and skip duplicate detection.",
      );
    }

    const existingContext = resolvedSpaceId
      ? await fetchExistingGeoContext({
          graphqlEndpoint: options.graphqlEndpoint,
          spaceId: resolvedSpaceId,
          typeName: options.typeName,
          entityNames: rows.map((row) => row.name),
        })
      : emptyGeoContext();

    const plan = await buildImportPlan({
      rows,
      typeName: options.typeName,
      sourceLabel,
      spaceId: resolvedSpaceId,
      existingContext,
      existingMode: options.existingMode,
    });

    printPlanSummary(plan);

    if (!options.publish) {
      console.log(
        "Dry run complete. Re-run with --publish and GEO_PRIVATE_KEY to submit the edit.",
      );
      return;
    }

    if (!publisher) {
      throw new Error("Publisher context was not resolved.");
    }

    if (plan.ops.length === 0) {
      console.log("Nothing to publish.");
      return;
    }

    const { cid, editId, to, calldata } = await personalSpace.publishEdit({
      name: options.editName,
      spaceId: publisher.spaceId,
      ops: plan.ops,
      author: publisher.spaceId,
      network: NETWORK,
    });

    console.log(`Published edit payload to IPFS (cid=${cid}, editId=${String(editId)}).`);

    const txHash = await publisher.smartAccount.sendTransaction({
      to,
      data: calldata,
    });

    console.log(`Submitted testnet transaction: ${txHash}`);

    const receipt = await publisher.publicClient.waitForTransactionReceipt({
      hash: txHash,
    });

    if (receipt.status === "reverted") {
      throw new Error(`Geo transaction reverted: ${txHash}`);
    }

    console.log(`Geo import complete for personal space ${publisher.spaceId}.`);
  } catch (error) {
    console.error(formatError(error));
    process.exitCode = 1;
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    sheetUrl: DEFAULT_SHEET_CSV_URL,
    graphqlEndpoint: process.env.GEO_GRAPHQL_ENDPOINT ?? DEFAULT_GRAPHQL_ENDPOINT,
    privateKey: normalizeOptionalPrivateKey(process.env.GEO_PRIVATE_KEY),
    spaceId: normalizeOptionalSpaceId(process.env.GEO_SPACE_ID),
    publish: false,
    typeName: DEFAULT_TYPE_NAME,
    editName: DEFAULT_EDIT_NAME,
    existingMode: "upsert",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--sheet-url":
        options.sheetUrl = requireValue(argv, ++index, "--sheet-url");
        break;
      case "--csv":
        options.csvPath = requireValue(argv, ++index, "--csv");
        break;
      case "--space-id":
        options.spaceId = normalizeSpaceId(requireValue(argv, ++index, "--space-id"));
        break;
      case "--private-key":
        options.privateKey = normalizePrivateKey(
          requireValue(argv, ++index, "--private-key"),
        );
        break;
      case "--type-name":
        options.typeName = requireValue(argv, ++index, "--type-name");
        break;
      case "--edit-name":
        options.editName = requireValue(argv, ++index, "--edit-name");
        break;
      case "--graphql-endpoint":
        options.graphqlEndpoint = requireValue(argv, ++index, "--graphql-endpoint");
        break;
      case "--max-rows":
        options.maxRows = parsePositiveInteger(
          requireValue(argv, ++index, "--max-rows"),
          "--max-rows",
        );
        break;
      case "--existing-mode":
        options.existingMode = parseExistingMode(
          requireValue(argv, ++index, "--existing-mode"),
        );
        break;
      case "--publish":
        options.publish = true;
        break;
      case "--dry-run":
        options.publish = false;
        break;
      case "--help":
        console.log(HELP_TEXT);
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.csvPath && options.sheetUrl !== DEFAULT_SHEET_CSV_URL) {
    throw new Error("Use either --csv or --sheet-url, not both.");
  }

  return options;
}

async function loadRows(options: CliOptions): Promise<SpreadsheetRow[]> {
  const csvText = options.csvPath
    ? await readFile(resolve(options.csvPath), "utf8")
    : await fetchText(options.sheetUrl);

  const records = parse(csvText, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    trim: true,
  }) as Array<Record<string, string>>;

  const rows = records
    .map(mapRecordToRow)
    .filter((row): row is SpreadsheetRow => row !== undefined);

  return options.maxRows ? rows.slice(0, options.maxRows) : rows;
}

function mapRecordToRow(record: Record<string, string>): SpreadsheetRow | undefined {
  const name = cleanCell(record.Name);

  if (!name) {
    return undefined;
  }

  return {
    name,
    description: cleanCell(record.Description),
    website: cleanCell(record.Website),
    x: cleanCell(record.X),
    avatar: cleanCell(record.Avatar),
    nativeTokens: cleanCell(record["Native Tokens (If any)"]),
    blockchains: splitList(record.Blockchains),
    topics: splitList(record.Topics),
  };
}

function emptyGeoContext(): ExistingGeoContext {
  return {
    propertiesByKey: {},
    existingEntitiesByName: new Map(),
    warnings: [],
  };
}

async function fetchExistingGeoContext(args: {
  graphqlEndpoint: string;
  spaceId: string;
  typeName: string;
  entityNames: string[];
}): Promise<ExistingGeoContext> {
  const warnings: string[] = [];
  const propertyNames = MANAGED_PROPERTIES.map((property) => property.name);

  const propertyData = await graphqlRequest<{
    properties: Array<{ id: string; name: string; dataTypeName?: string | null }>;
  }>(
    args.graphqlEndpoint,
    `
      query ExistingProperties($spaceId: UUID!, $names: [String!]) {
        properties(
          spaceId: $spaceId
          first: 100
          filter: { name: { inInsensitive: $names } }
        ) {
          id
          name
          dataTypeName
        }
      }
    `,
    {
      spaceId: args.spaceId,
      names: propertyNames,
    },
  );

  const propertiesByKey: Partial<Record<ManagedPropertyKey, string>> = {};

  for (const property of MANAGED_PROPERTIES) {
    const existing = propertyData.properties.find(
      (candidate) => normalizeName(candidate.name) === normalizeName(property.name),
    );

    if (existing) {
      propertiesByKey[property.key] = existing.id;
    }
  }

  const typeData = await graphqlRequest<{
    typesList: Array<{ id: string; name: string }>;
  }>(
    args.graphqlEndpoint,
    `
      query ExistingType($spaceId: UUID!, $typeName: String!) {
        typesList(
          spaceId: $spaceId
          first: 10
          filter: { name: { isInsensitive: $typeName } }
        ) {
          id
          name
        }
      }
    `,
    {
      spaceId: args.spaceId,
      typeName: args.typeName,
    },
  );

  const typeId = typeData.typesList[0]?.id;
  const existingEntitiesByName = new Map<string, ExistingEntity>();

  if (typeId && args.entityNames.length > 0) {
    const entityData = await graphqlRequest<{
      entities: Array<{ id: string; name: string }>;
    }>(
      args.graphqlEndpoint,
      `
        query ExistingEntities(
          $spaceId: UUID!
          $typeId: UUID!
          $names: [String!]
        ) {
          entities(
            spaceId: $spaceId
            first: 500
            filter: {
              and: [
                { typeIds: { anyEqualTo: $typeId } }
                { name: { inInsensitive: $names } }
              ]
            }
          ) {
            id
            name
          }
        }
      `,
      {
        spaceId: args.spaceId,
        typeId,
        names: args.entityNames,
      },
    );

    for (const entity of entityData.entities) {
      existingEntitiesByName.set(normalizeName(entity.name), entity);
    }
  }

  const missingProperties = MANAGED_PROPERTIES.filter(
    (property) => !propertiesByKey[property.key],
  );

  if (typeId && missingProperties.length > 0) {
    warnings.push(
      `The type "${args.typeName}" already exists in space ${args.spaceId}, but ${missingProperties.length} managed properties are missing and will be created separately.`,
    );
  }

  return {
    typeId,
    propertiesByKey,
    existingEntitiesByName,
    warnings,
  };
}

async function buildImportPlan(args: {
  rows: SpreadsheetRow[];
  typeName: string;
  sourceLabel: string;
  spaceId?: string;
  existingContext: ExistingGeoContext;
  existingMode: ExistingMode;
}): Promise<ImportPlan> {
  const ops: Op[] = [];
  const createdProperties: string[] = [];
  const createdEntities: string[] = [];
  const updatedEntities: string[] = [];
  const skippedEntities: string[] = [];
  const warnings = [...args.existingContext.warnings];

  const propertiesByKey: Partial<Record<ManagedPropertyKey, string>> = {
    ...args.existingContext.propertiesByKey,
  };

  for (const property of MANAGED_PROPERTIES) {
    if (propertiesByKey[property.key]) {
      continue;
    }

    const result = Graph.createProperty({
      name: property.name,
      description: property.description,
      dataType: "TEXT",
    });

    propertiesByKey[property.key] = String(result.id);
    createdProperties.push(property.name);
    ops.push(...result.ops);
  }

  let typeId = args.existingContext.typeId;
  let createdType: string | undefined;

  if (!typeId) {
    const result = Graph.createType({
      name: args.typeName,
      description: `Imported from ${args.sourceLabel}.`,
      properties: MANAGED_PROPERTIES.map((property) =>
        requirePropertyId(propertiesByKey, property.key),
      ),
    });

    typeId = String(result.id);
    createdType = args.typeName;
    ops.push(...result.ops);
  }

  for (const row of args.rows) {
    const existing = args.existingContext.existingEntitiesByName.get(
      normalizeName(row.name),
    );

    if (existing) {
      if (args.existingMode === "skip") {
        skippedEntities.push(row.name);
        continue;
      }

      if (args.existingMode === "error") {
        throw new Error(
          `Entity "${row.name}" already exists in Geo space ${args.spaceId}. Use --existing-mode upsert or skip instead.`,
        );
      }

      const result = Graph.updateEntity({
        id: existing.id,
        name: row.name,
        description: row.description,
        values: buildValues(row, propertiesByKey),
        unset: buildUnsetList(row, propertiesByKey),
      });

      updatedEntities.push(row.name);
      ops.push(...result.ops);
      continue;
    }

    let coverId: string | undefined;

    if (row.avatar) {
      try {
        const imageResult = await Graph.createImage({
          url: row.avatar,
          network: NETWORK,
        });

        coverId = String(imageResult.id);
        ops.push(...imageResult.ops);
      } catch (error) {
        warnings.push(
          `Could not import the avatar image for "${row.name}": ${formatError(error)}`,
        );
      }
    }

    const entityResult = Graph.createEntity({
      name: row.name,
      description: row.description,
      cover: coverId,
      types: [typeId],
      values: buildValues(row, propertiesByKey),
    });

    createdEntities.push(row.name);
    ops.push(...entityResult.ops);
  }

  return {
    ops,
    spaceId: args.spaceId,
    typeId,
    createdProperties,
    createdType,
    createdEntities,
    updatedEntities,
    skippedEntities,
    warnings,
  };
}

function buildValues(
  row: SpreadsheetRow,
  propertiesByKey: Partial<Record<ManagedPropertyKey, string>>,
): Array<{ property: string; type: "text"; value: string }> {
  const values: Array<{ property: string; type: "text"; value: string }> = [];

  const maybePush = (key: ManagedPropertyKey, value?: string): void => {
    if (!value) {
      return;
    }

    values.push({
      property: requirePropertyId(propertiesByKey, key),
      type: "text",
      value,
    });
  };

  maybePush("website", row.website);
  maybePush("x", row.x);
  maybePush("avatarUrl", row.avatar);
  maybePush("nativeTokens", row.nativeTokens);
  maybePush("blockchains", joinList(row.blockchains));
  maybePush("topics", joinList(row.topics));

  return values;
}

function buildUnsetList(
  row: SpreadsheetRow,
  propertiesByKey: Partial<Record<ManagedPropertyKey, string>>,
): Array<{ property: string }> {
  const unset = MANAGED_PROPERTIES.map((property) => ({
    property: requirePropertyId(propertiesByKey, property.key),
  }));

  if (!row.description) {
    unset.push({ property: String(SystemIds.DESCRIPTION_PROPERTY) });
  }

  return unset;
}

async function resolvePublisherContext(
  privateKey: `0x${string}`,
): Promise<PublisherContext> {
  const smartAccount = await getSmartAccountWalletClient({
    privateKey,
  });

  const smartAccountAddress = smartAccount.account.address;

  const hasSpace = await personalSpace.hasSpace({
    address: smartAccountAddress,
  });

  if (!hasSpace) {
    throw new Error(
      "No personal space exists for this Geo smart account yet. Create one in Geo Genesis before publishing.",
    );
  }

  const publicClient = createPublicClient({
    transport: http(TESTNET_RPC_URL),
  });

  const spaceIdHex = (await publicClient.readContract({
    address: TESTNET.SPACE_REGISTRY_ADDRESS,
    abi: SpaceRegistryAbi,
    functionName: "addressToSpaceId",
    args: [smartAccountAddress],
  })) as Hex;

  return {
    smartAccount,
    publicClient,
    smartAccountAddress,
    spaceId: hexToUuid(spaceIdHex),
  };
}

async function graphqlRequest<TData>(
  endpoint: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<TData> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query,
      variables,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Geo GraphQL request failed with ${response.status} ${response.statusText}.`,
    );
  }

  const payload = (await response.json()) as {
    data?: TData;
    errors?: Array<{ message?: string }>;
  };

  if (payload.errors?.length) {
    throw new Error(
      payload.errors
        .map((error) => error.message ?? "Unknown GraphQL error")
        .join("; "),
    );
  }

  if (!payload.data) {
    throw new Error("Geo GraphQL response did not include data.");
  }

  return payload.data;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Request to ${url} failed with ${response.status}.`);
  }

  return response.text();
}

function printPlanSummary(plan: ImportPlan): void {
  console.log("");
  console.log("Import plan");
  console.log("-----------");
  console.log(`Ops prepared: ${plan.ops.length}`);
  console.log(`Type ID: ${plan.typeId}`);
  console.log(
    `Properties to create: ${plan.createdProperties.length}${formatPreview(plan.createdProperties)}`,
  );
  console.log(
    `Entities to create: ${plan.createdEntities.length}${formatPreview(plan.createdEntities)}`,
  );
  console.log(
    `Entities to update: ${plan.updatedEntities.length}${formatPreview(plan.updatedEntities)}`,
  );
  console.log(
    `Entities to skip: ${plan.skippedEntities.length}${formatPreview(plan.skippedEntities)}`,
  );

  if (plan.createdType) {
    console.log(`Type to create: ${plan.createdType}`);
  }

  if (plan.warnings.length > 0) {
    console.log("");
    console.log("Warnings");
    console.log("--------");
    for (const warning of plan.warnings) {
      console.log(`- ${warning}`);
    }
  }

  console.log("");
}

function requirePropertyId(
  propertiesByKey: Partial<Record<ManagedPropertyKey, string>>,
  key: ManagedPropertyKey,
): string {
  const propertyId = propertiesByKey[key];

  if (!propertyId) {
    throw new Error(`Missing property ID for ${key}.`);
  }

  return propertyId;
}

function splitList(value: string | undefined): string[] {
  const cleaned = cleanCell(value);
  if (!cleaned) {
    return [];
  }

  return cleaned
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinList(values: string[]): string | undefined {
  if (values.length === 0) {
    return undefined;
  }

  return values.join(", ");
}

function cleanCell(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function findDuplicateNames(rows: SpreadsheetRow[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const row of rows) {
    const normalized = normalizeName(row.name);

    if (seen.has(normalized)) {
      duplicates.add(row.name);
      continue;
    }

    seen.add(normalized);
  }

  return [...duplicates].sort((left, right) => left.localeCompare(right));
}

function formatPreview(values: string[]): string {
  if (values.length === 0) {
    return "";
  }

  const preview = values.slice(0, 5).join(", ");
  const suffix = values.length > 5 ? ", ..." : "";

  return ` (${preview}${suffix})`;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSpaceId(value: string): string {
  const normalized = value.replaceAll("-", "").trim().toLowerCase();

  if (!/^[0-9a-f]{32}$/.test(normalized)) {
    throw new Error(
      `Expected a Geo space ID / UUID with 32 hex characters, received "${value}".`,
    );
  }

  return normalized;
}

function normalizeOptionalSpaceId(value: string | undefined): string | undefined {
  return value ? normalizeSpaceId(value) : undefined;
}

function normalizePrivateKey(value: string): `0x${string}` {
  const normalized = value.startsWith("0x") ? value : `0x${value}`;

  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("Expected a 32-byte private key in hex format.");
  }

  return normalized as `0x${string}`;
}

function normalizeOptionalPrivateKey(
  value: string | undefined,
): `0x${string}` | undefined {
  return value ? normalizePrivateKey(value) : undefined;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];

  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }

  return value;
}

function parseExistingMode(value: string): ExistingMode {
  if (value === "upsert" || value === "skip" || value === "error") {
    return value;
  }

  throw new Error(`Invalid existing mode "${value}". Use upsert, skip, or error.`);
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }

  return parsed;
}

function hexToUuid(value: Hex): string {
  return value.slice(2, 34).toLowerCase();
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

void main();
