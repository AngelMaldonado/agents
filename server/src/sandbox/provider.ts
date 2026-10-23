// Where a task's mini-computer comes from. v1 is Docker on reko-3; microsandbox or a cloud
// provider would implement the same three calls.
export type SandboxSpec = {
	name: string;
	image: string;
	env: Record<string, string>;
	memoryBytes: number;
	cpus: number;
	labels: Record<string, string>;
};

export interface SandboxProvider {
	/** Creates and starts the sandbox; returns its id. */
	start(spec: SandboxSpec): Promise<string>;
	/** Stops and removes it. Never throws if it is already gone. */
	destroy(id: string): Promise<void>;
	/** Ids of every sandbox carrying the given label, running or not. */
	list(label: string): Promise<string[]>;
}
