import type { ErrorDiagnostic, SemanticConnectionsSettings, Vector } from "../types";
import { normalizeErrorDiagnostic } from "../utils/error-utils";
import { MockProvider } from "./mock-provider";
import type { EmbeddingProvider } from "./provider";
import { RemoteProvider } from "./remote-provider";

type ServiceOperationFailure = {
	ok: false;
	error: string;
	diagnostic: ErrorDiagnostic;
};

type ServiceOperationSuccess<T> = { ok: true } & T;

export class EmbeddingService {
	private provider: EmbeddingProvider;

	constructor(private settings: SemanticConnectionsSettings) {
		this.provider = this.createProvider(settings);
	}

	get providerName(): string {
		return this.provider.name;
	}

	get dimension(): number {
		return this.provider.dimension;
	}

	async embed(text: string): Promise<Vector> {
		return this.provider.embed(text);
	}

	async embedBatch(texts: string[]): Promise<Vector[]> {
		return this.provider.embedBatch(texts);
	}

	switchProvider(settings: SemanticConnectionsSettings): void {
		if (this.provider.dispose) {
			void this.provider.dispose();
		}

		this.settings = settings;
		this.provider = this.createProvider(settings);
	}

	async disposeCurrentProvider(): Promise<void> {
		if (this.provider.dispose) {
			await this.provider.dispose();
		}
	}

	async testConnection(): Promise<
		ServiceOperationSuccess<{ dimension: number }> | ServiceOperationFailure
	> {
		try {
			const vec = await this.provider.embed("connection test");
			return { ok: true, dimension: vec.length };
		} catch (err) {
			return this.buildFailureResult(err);
		}
	}

	private buildFailureResult(error: unknown): ServiceOperationFailure {
		const diagnostic = normalizeErrorDiagnostic(error);
		return {
			ok: false,
			error: diagnostic.message,
			diagnostic,
		};
	}

	private createRemoteProvider(settings: SemanticConnectionsSettings): RemoteProvider {
		return new RemoteProvider({
			baseUrl: settings.remoteBaseUrl,
			apiKey: settings.remoteApiKey,
			model: settings.remoteModel,
			timeoutMs: settings.remoteTimeoutMs,
			batchSize: settings.remoteBatchSize,
		});
	}

	private createProvider(settings: SemanticConnectionsSettings): EmbeddingProvider {
		switch (settings.embeddingProvider) {
			case "remote":
				return this.createRemoteProvider(settings);
			case "mock":
			default:
				return new MockProvider();
		}
	}
}
