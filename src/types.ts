/**
 * Shared plugin types.
 */

export type Vector = number[];

export interface ErrorDiagnostic {
	message: string;
	name?: string;
	code?: string;
	stage?: string;
	stack?: string;
	details?: string[];
}

export type RuntimeLogLevel = "info" | "warn";

export type RuntimeLogCategory =
	| "lifecycle"
	| "indexing"
	| "embedding"
	| "storage"
	| "configuration"
	| "query";

export interface RuntimeLogEntry {
	timestamp: number;
	event: string;
	level: RuntimeLogLevel;
	category: RuntimeLogCategory;
	message: string;
	provider?: string;
	details?: string[];
}

export interface NoteMeta {
	path: string;
	title: string;
	mtime: number;
	hash: string;
	tags: string[];
	outgoingLinks: string[];
	summaryText: string;
	vector?: Vector;
}

export interface ChunkMeta {
	chunkId: string;
	notePath: string;
	heading: string;
	text: string;
	order: number;
	vector?: Vector;
}

export interface ConnectionResult {
	notePath: string;
	title: string;
	score: number;
	noteScore: number;
	passageScore: number;
	bestPassage: PassageResult;
}

export interface PassageResult {
	chunkId: string;
	heading: string;
	text: string;
	score: number;
}

export interface LookupResult {
	notePath: string;
	title: string;
	passage: PassageResult;
	score: number;
}

export interface SemanticConnectionsSettings {
	maxConnections: number;
	excludedFolders: string[];
	embeddingProvider: "mock" | "remote";
	autoIndex: boolean;
	autoOpenConnectionsView: boolean;
	remoteBaseUrl: string;
	remoteApiKey: string;
	remoteModel: string;
	remoteTimeoutMs: number;
	remoteBatchSize: number;
}

export type ErrorLogType =
	| "embedding"
	| "scanning"
	| "chunking"
	| "storage"
	| "query"
	| "runtime"
	| "configuration"
	| "unknown";

export interface IndexErrorEntry {
	timestamp: number;
	filePath: string;
	errorType: ErrorLogType;
	message: string;
	provider?: string;
	errorName?: string;
	errorCode?: string;
	stage?: string;
	stack?: string;
	details?: string[];
}

export interface IndexSummary {
	total: number;
	failed: number;
}

export type RebuildIndexStage = "preparing" | "indexing" | "saving" | "success" | "error";

export interface RebuildIndexProgress {
	stage: RebuildIndexStage;
	message: string;
	done?: number;
	total?: number;
	percent?: number;
	file?: string;
	failed?: number;
	indexedNotes?: number;
}

export interface IndexStoragePartSummary {
	label: string;
	path: string;
	bytes: number;
	share: number;
}

export interface IndexStorageSummary {
	noteCount: number;
	chunkCount: number;
	vectorCount: number;
	noteVectorCount: number;
	chunkVectorCount: number;
	embeddingDimension: number;
	snapshotFormat: "missing" | "json-only" | "json+binary";
	parts: IndexStoragePartSummary[];
	totalBytes: number;
}

export const DEFAULT_SETTINGS: SemanticConnectionsSettings = {
	maxConnections: 20,
	excludedFolders: [],
	embeddingProvider: "remote",
	autoIndex: true,
	autoOpenConnectionsView: true,
	remoteBaseUrl: "",
	remoteApiKey: "",
	remoteModel: "BAAI/bge-m3",
	remoteTimeoutMs: 30_000,
	remoteBatchSize: 16,
};
