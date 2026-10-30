// Where a task's mini-computer comes from. v1 is Docker on reko-3; microsandbox or a cloud
// provider would implement the same calls.
export type SandboxSpec = {
	name: string;
	image: string;
	env: Record<string, string>;
	memoryBytes: number;
	cpus: number;
	labels: Record<string, string>;
	/** Named volumes mounted into the sandbox (an agent's state); created on first use. */
	volumes?: { name: string; target: string; labels?: Record<string, string> }[];
};

export interface SandboxProvider {
	/** Creates and starts the sandbox; returns its id. */
	start(spec: SandboxSpec): Promise<string>;
	/** Stops and removes it. Never throws if it is already gone. */
	destroy(id: string): Promise<void>;
	/** Every sandbox carrying the given label (key=value), running or not, with its labels. */
	list(label: string): Promise<SandboxInfo[]>;
	/** What one running sandbox is using right now (null if it is gone). */
	stats(id: string): Promise<SandboxStats | null>;
	/** The machine the sandboxes run on. */
	host(): Promise<HostInfo>;
}

export type SandboxInfo = { id: string; name: string; labels: Record<string, string>; state: string; created: number };
export type SandboxStats = {
	cpuPercent: number;
	memoryBytes: number;
	memoryLimit: number;
	netRx: number;
	netTx: number;
};
export type HostInfo = { cpus: number; memoryTotal: number; memoryAvailable: number; load1: number };
