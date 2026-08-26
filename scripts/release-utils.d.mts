export interface PackageManifest {
  readonly name: string;
  readonly version?: string;
  readonly private?: boolean;
  readonly repository?: { readonly url?: string };
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

export interface WorkspacePackage {
  readonly manifest: PackageManifest;
  readonly packageRoot: string;
}

export function discoverPublicPackages(root: string): Promise<WorkspacePackage[]>;
export function validateRelease(
  root: string,
  tag: string | undefined
): Promise<{ errors: string[]; publicPackages: WorkspacePackage[]; version: string | null }>;
export function sortPackagesForPublish<T extends WorkspacePackage>(packages: T[]): T[];
export function packPublicPackages(
  root: string,
  destination: string
): Promise<{
  packages: WorkspacePackage[];
  plan: Array<{
    name: string;
    version: string;
    archive: string;
    integrity: string;
    sha256: string;
  }>;
}>;
export const EXPECTED_REPOSITORY: string;
