import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".css":  "text/css; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".txt":  "text/plain; charset=utf-8",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
};

function mimeType(file: string): string {
  return MIME_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

// Rewritten every run under the same name, so browsers and agents must revalidate.
const NO_CACHE = new Set(["index.html", "archive.html", "manifest.json", "latest.json"]);

function md5(file: string): string {
  return crypto.createHash("md5").update(fs.readFileSync(file)).digest("hex");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

export interface PublishOptions {
  /** Local directory to sync (e.g. output/web) */
  localDir: string;
  /** S3 bucket name (or set S3_BUCKET env var) */
  bucket?: string;
  /** AWS region (default: us-east-1 or AWS_REGION env var) */
  region?: string;
  /** Optional S3 key prefix */
  prefix?: string;
}

export async function publishOutput(opts: PublishOptions): Promise<void> {
  const bucket = opts.bucket ?? process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error(
      "S3 bucket is required. Pass --bucket or set S3_BUCKET env var."
    );
  }

  const region = opts.region ?? process.env.AWS_REGION ?? "us-east-1";
  const prefix = opts.prefix ?? process.env.S3_PREFIX ?? "";
  const localDir = path.resolve(opts.localDir);

  const client = new S3Client({ region });

  // Build local file map: s3-key → local path
  const localFiles = walk(localDir);
  const localMap = new Map<string, string>();
  for (const f of localFiles) {
    const rel = path.relative(localDir, f).replace(/\\/g, "/");
    const key = prefix ? `${prefix}/${rel}` : rel;
    localMap.set(key, f);
  }

  console.log(`[publish] Syncing ${localMap.size} local files to s3://${bucket}${prefix ? "/" + prefix : ""}...`);

  // List all remote objects (paginated)
  const remoteMap = new Map<string, string>(); // key → etag
  let token: string | undefined;
  do {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix || undefined,
        ContinuationToken: token,
      })
    );
    for (const obj of resp.Contents ?? []) {
      if (obj.Key && obj.ETag) {
        remoteMap.set(obj.Key, obj.ETag.replace(/"/g, ""));
      }
    }
    token = resp.NextContinuationToken;
  } while (token);

  // Upload new or changed files
  let uploaded = 0;
  for (const [key, localPath] of localMap) {
    if (md5(localPath) === remoteMap.get(key)) continue;
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: fs.readFileSync(localPath),
        ContentType: mimeType(localPath),
        ...(NO_CACHE.has(path.relative(localDir, localPath).replace(/\\/g, "/")) ? { CacheControl: "no-cache" } : {}),
      })
    );
    console.log(`[publish] ↑ ${key}`);
    uploaded++;
  }

  // Delete remote files no longer present locally
  let deleted = 0;
  for (const key of remoteMap.keys()) {
    if (!localMap.has(key)) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      console.log(`[publish] ✕ ${key}`);
      deleted++;
    }
  }

  const unchanged = localMap.size - uploaded;
  console.log(
    `[publish] Done: ${uploaded} uploaded, ${deleted} deleted, ${unchanged} unchanged`
  );

  // Invalidate CloudFront cache
  const distributionId = process.env.CLOUDFRONT_DISTRIBUTION_ID;
  if (distributionId) {
    console.log(`[publish] Invalidating CloudFront ${distributionId}...`);
    const cf = new CloudFrontClient({ region: "us-east-1" });
    await cf.send(
      new CreateInvalidationCommand({
        DistributionId: distributionId,
        InvalidationBatch: {
          CallerReference: Date.now().toString(),
          Paths: { Quantity: 1, Items: ["/*"] },
        },
      })
    );
    console.log("[publish] Invalidation created.");
  }
}
