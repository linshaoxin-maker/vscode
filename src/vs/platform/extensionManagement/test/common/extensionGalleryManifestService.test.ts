/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IProductService } from '../../../product/common/productService.js';
import { ExtensionGalleryManifestService } from '../../common/extensionGalleryManifestService.js';
import { ExtensionGalleryManifestStatus, ExtensionGalleryResourceType } from '../../common/extensionGalleryManifest.js';

// The Open VSX config that FEAT-006a writes into product.json. The gallery is
// considered Available iff `extensionsGallery.serviceUrl` is set, so this test
// pins the manifest the chipos product config produces.
const OPEN_VSX = {
	serviceUrl: 'https://open-vsx.org/vscode/gallery',
	itemUrl: 'https://open-vsx.org/vscode/item',
	resourceUrlTemplate: 'https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}',
	controlUrl: '',
	nlsBaseUrl: '',
	publisherUrl: '',
};

suite('ExtensionGalleryManifestService', () => {
	const ds = ensureNoDisposablesAreLeakedInTestSuite();

	function serviceWithGallery(extensionsGallery: object | undefined): ExtensionGalleryManifestService {
		const productService = { extensionsGallery } as unknown as IProductService;
		return ds.add(new ExtensionGalleryManifestService(productService));
	}

	const resourceId = (manifest: { resources: ReadonlyArray<{ id: string; type: string }> }, type: ExtensionGalleryResourceType): string | undefined =>
		manifest.resources.find(r => r.type === type)?.id;

	test('a gallery with a serviceUrl is Available and yields the query + resource + item URLs', async () => {
		const service = serviceWithGallery(OPEN_VSX);
		assert.strictEqual(service.extensionGalleryManifestStatus, ExtensionGalleryManifestStatus.Available);

		const manifest = await service.getExtensionGalleryManifest();
		assert.ok(manifest, 'manifest should not be null when a serviceUrl is configured');
		assert.strictEqual(resourceId(manifest, ExtensionGalleryResourceType.ExtensionQueryService), 'https://open-vsx.org/vscode/gallery/extensionquery');
		assert.strictEqual(resourceId(manifest, ExtensionGalleryResourceType.ExtensionResourceUri), OPEN_VSX.resourceUrlTemplate);
		assert.strictEqual(resourceId(manifest, ExtensionGalleryResourceType.ExtensionDetailsViewUri), 'https://open-vsx.org/vscode/item?itemName={publisher}.{name}');
	});

	test('no extensionsGallery → Unavailable and a null manifest', async () => {
		const service = serviceWithGallery(undefined);
		assert.strictEqual(service.extensionGalleryManifestStatus, ExtensionGalleryManifestStatus.Unavailable);
		assert.strictEqual(await service.getExtensionGalleryManifest(), null);
	});
});
