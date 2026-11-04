export type ImageIdentity = {
	imageId: string;
	version: string | null;
	development: boolean;
	revision: string | null;
	dirty: boolean | null;
};

/** The short label people read: a release, or a Dev build by its commit (or its image, without one). */
export function imageVersion(image: ImageIdentity | null) {
	if (!image) return 'Sin imagen validada';
	if (image.version) return `v${image.version}`;
	if (image.development) {
		if (image.revision) return `Dev · ${image.revision.slice(0, 7)}${image.dirty ? ' (con cambios)' : ''}`;
		return `Dev · ${image.imageId.slice(7, 14)}`;
	}
	return 'Versión desconocida';
}

/** The long form, for a tooltip: what exactly is known and what is not. */
export function imageDetail(image: (ImageIdentity & { piVersion?: string | null }) | null) {
	if (!image) return 'El agente todavía no tiene una imagen validada.';
	const parts = [`Imagen ${image.imageId.slice(7, 19)}`];
	if (image.version) parts.push(`release v${image.version}`);
	else if (image.development)
		parts.push(image.revision ? `commit ${image.revision.slice(0, 12)}` : 'commit desconocido');
	if ('piVersion' in image) parts.push(`pi ${image.piVersion ?? 'desconocido'}`);
	return parts.join(' · ');
}
