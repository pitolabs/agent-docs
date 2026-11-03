// A stub S3 for the archive tests: HEAD/PUT/GET/LIST over a map, with S3's rules that the code depends on:
// If-None-Match: * on an existing key -> 412, x-amz-meta-description kept, a new version id per PUT, ListObjectsV2
// paging with a continuation token. Keys in `objects` carry the leading "/" of the URL path.
import { DocsArchive } from "../src/core/s3.ts";

export interface StubObject {
	body: string;
	meta: string;
	contentType?: string;
	versionId?: string;
}

export function stubS3(bucket = "b") {
	const objects = new Map<string, StubObject>();
	let version = 0;
	const http = (async (req: Request) => {
		const url = new URL(req.url);
		const path = decodeURIComponent(url.pathname);
		if (req.method === "HEAD") {
			const o = objects.get(path);
			return new Response(null, { status: o ? 200 : 404, headers: o?.meta ? { "x-amz-meta-description": o.meta } : {} });
		}
		if (req.method === "PUT") {
			if (req.headers.get("if-none-match") === "*" && objects.has(path)) return new Response(null, { status: 412 });
			const versionId = `v${++version}`;
			objects.set(path, {
				body: Buffer.from(await req.arrayBuffer()).toString(),
				meta: req.headers.get("x-amz-meta-description") ?? "",
				contentType: req.headers.get("content-type") ?? undefined,
				versionId,
			});
			return new Response(null, { status: 200, headers: { "x-amz-version-id": versionId } });
		}
		if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
			// S3 ListObjectsV2: keys in order, max-keys per page, an opaque token for the next page.
			const prefix = `/${url.searchParams.get("prefix") ?? ""}`;
			const max = Number(url.searchParams.get("max-keys") ?? 1000);
			const start = Number(Buffer.from(url.searchParams.get("continuation-token") ?? "MA==", "base64").toString());
			const all = [...objects].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
			const rows = all
				.slice(start, start + max)
				.map(([k, o]) => `<Contents><Key>${k.slice(1)}</Key><LastModified>2026-11-03T10:00:00.000Z</LastModified><Size>${o.body.length}</Size></Contents>`);
			const more = start + max < all.length;
			const next = more ? `<NextContinuationToken>${Buffer.from(String(start + max)).toString("base64")}</NextContinuationToken>` : "";
			return new Response(`<ListBucketResult><IsTruncated>${more}</IsTruncated>${next}${rows.join("")}</ListBucketResult>`, { status: 200 });
		}
		if (req.method === "GET") {
			const o = objects.get(path);
			if (!o) return new Response(null, { status: 404 });
			return new Response(o.body, {
				status: 200,
				headers: {
					"Content-Type": o.contentType ?? "application/pdf",
					"Last-Modified": "Tue, 03 Nov 2026 10:00:00 GMT",
					...(o.versionId ? { "x-amz-version-id": o.versionId } : {}),
				},
			});
		}
		return new Response(null, { status: 400 });
	}) as unknown as typeof fetch;
	return { objects, http, docs: new DocsArchive({ bucket, region: "eu-central-1", accessKeyId: "AKIAEXAMPLE", secretAccessKey: "s" }, http) };
}
