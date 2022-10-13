import Chunk from './Chunk';
import type ExternalModule from './ExternalModule';
import type Graph from './Graph';
import Module from './Module';
import type {
	GetManualChunk,
	NormalizedInputOptions,
	NormalizedOutputOptions,
	OutputAsset,
	OutputBundle,
	OutputChunk,
	WarningHandler
} from './rollup/types';
import type { PluginDriver } from './utils/PluginDriver';
import { type Addons, createAddons } from './utils/addons';
import { getChunkAssignments } from './utils/chunkAssignment';
import commondir from './utils/commondir';
import {
	errCannotAssignModuleToChunk,
	errChunkInvalid,
	errInvalidOption,
	error,
	warnDeprecation
} from './utils/error';
import { sortByExecutionOrder } from './utils/executionOrder';
import { type GenerateCodeSnippets, getGenerateCodeSnippets } from './utils/generateCodeSnippets';
import {
	FILE_PLACEHOLDER,
	getOutputBundle,
	OutputBundleWithPlaceholders
} from './utils/outputBundle';
import { basename, isAbsolute } from './utils/path';
import { timeEnd, timeStart } from './utils/timers';

// Bundle类可以说明为一次构建一个Bundle类
export default class Bundle {
	private readonly facadeChunkByModule = new Map<Module, Chunk>();
	private readonly includedNamespaces = new Set<Module>();

	constructor(
		private readonly outputOptions: NormalizedOutputOptions,
		private readonly unsetOptions: ReadonlySet<string>,
		private readonly inputOptions: NormalizedInputOptions,
		private readonly pluginDriver: PluginDriver,
		private readonly graph: Graph
	) {}

	async generate(isWrite: boolean): Promise<OutputBundle> {
		timeStart('GENERATE', 1);
		const outputBundleBase: OutputBundle = Object.create(null); // 创建一个基础输出bundle对象 - 是一个空对象
		const outputBundle = getOutputBundle(outputBundleBase); // 主要就是对基础输出bundle对象做proxy代理，对get、set、deleteProperty操作做拦截
		this.pluginDriver.setOutputBundle(outputBundle, this.outputOptions, this.facadeChunkByModule); // 给插件驱动设置输出bundle对象
		try {
			await this.pluginDriver.hookParallel('renderStart', [this.outputOptions, this.inputOptions]); // 并发执行renderStart钩子函数，不关心钩子函数所返回的结果

			timeStart('generate chunks', 2);
			const chunks = await this.generateChunks(); // 生成Chunk类实例对象，产生一个数组
			if (chunks.length > 1) {
				validateOptionsForMultiChunkOutput(this.outputOptions, this.inputOptions.onwarn);
			}
			const inputBase = commondir(getAbsoluteEntryModulePaths(chunks));
			timeEnd('generate chunks', 2);

			timeStart('render modules', 2);

			// We need to create addons before prerender because at the moment, there
			// can be no async code between prerender and render due to internal state
			const addons = await createAddons(this.outputOptions, this.pluginDriver);
			const snippets = getGenerateCodeSnippets(this.outputOptions);
			this.prerenderChunks(chunks, inputBase, snippets); // 对每个chunk进行预渲染，调用Chunk实例的preRender函数，
			// 大致操作是对当前chunk中所包含的所有的module执行render函数，把它返回的结果
			// 统一做个整合，形成最终代码赋值给Chunk实例对象的renderedSource属性
			// 那么module的render函数主要就是返回此模块中的代码字符串 - 重要的一步就是每个模块中的tree-shaking
			timeEnd('render modules', 2);

			// src
			//   finalisers
			//     iife.ts
			//     es.ts
			//     cjs.ts
			//     index.ts
			//   Chunk.ts
			//   utils
			//     renderChunk.ts
			//     PluginContext.ts
			//     PluginDriver.ts
			//     FileEmitter.ts

			// ***
			// 注意：在插件驱动中所执行的插件hook的this是其内部绑定的PluginContext实例对象
			// 我们知道在vite中写的renderChunk、generatorBundle钩子中，他会去调用this.emitFile函数
			// 那么这个就是调用的插件上下文对象中的emitFile函数，那么实际上又是执行的fileEmitter.emitFile
			// 那么这个函数中主要逻辑是向输出bundle对象中添加属性值，属性值的含义是 {输出文件名=>输出文件的信息}
			// ***


			// 添加这些最终块到bundle中
			// 这一步主要逻辑是把所有的chunk实例对象相关的有用信息形成一个对象添加到输出bundle对象中
			// 随后并发执行Chunk实例对象的render函数，在render函数中取出Chunk实例对象的renderedSource属性值
			// 首先对其进行finalise函数的执行，这个函数来自于当前输出选项中的格式format的值是什么，那么这个函数
			// 就是finalisers下对应文件默认暴露的函数，这些函数主要是根据当前的format值产生最终输出代码的结构格式的，比如iife格式、es格式、commonjs格式等
			// 转为这些最终的格式代码之后 -> 接着prepend addons.banner -> 再接着append addons.footer
			// 产生当前的prevCode字符串 -> 接着对prevCode执行renderChunk
			// 在renderChunk函数中主要是进行promise.then链执行插件驱动中的renderChunk钩子函数
			// 那么prevCode就是作为第一个hook的参数，hook若返回结果那么直接把返回的结果作为下一个hook的参数
			// 若没有返回结果则把上次的arg0作为下次hook的参数 -> 得到最终结果代码
			// 这个最终处理的结果code也是作为{ code, map }在Chunk实例对象的render函数所执行后的结果
			// 最终这个{ code, map }对象是被合并到了bundle对象以chunk.id为key对应的值对象中了 ~
			await this.addFinalizedChunksToBundle(chunks, inputBase, addons, outputBundle, snippets);
		} catch (err: any) {
			await this.pluginDriver.hookParallel('renderError', [err]);
			throw err;
		}
		// 按照promise.then链执行generateBundle钩子函数，不关心钩子函数所返回的结果
		await this.pluginDriver.hookSeq('generateBundle', [
			this.outputOptions,
			outputBundle as OutputBundle, // 钩子函数的第二个参数就是输出bundle对象啦 ~
			isWrite
		]);
		// 这一步主要是对输出bundle对象的values进行校验的，也没有做什么其它的事情
		this.finaliseAssets(outputBundle);

		timeEnd('GENERATE', 1);
		return outputBundleBase; // 返回的是基础输出bundle对象，不是它的代理对象
	}

	private async addFinalizedChunksToBundle(
		chunks: readonly Chunk[],
		inputBase: string,
		addons: Addons,
		bundle: OutputBundleWithPlaceholders,
		snippets: GenerateCodeSnippets
	): Promise<void> {
		this.assignChunkIds(chunks, inputBase, addons, bundle);
		for (const chunk of chunks) {
			bundle[chunk.id!] = chunk.getChunkInfoWithFileNames() as OutputChunk;
		}
		await Promise.all(
			chunks.map(async chunk => {
				const outputChunk = bundle[chunk.id!] as OutputChunk;
				Object.assign(
					outputChunk,
					await chunk.render(this.outputOptions, addons, outputChunk, snippets)
				);
			})
		);
	}

	private async addManualChunks(
		manualChunks: Record<string, readonly string[]>
	): Promise<Map<Module, string>> {
		const manualChunkAliasByEntry = new Map<Module, string>();
		const chunkEntries = await Promise.all(
			Object.entries(manualChunks).map(async ([alias, files]) => ({
				alias,
				entries: await this.graph.moduleLoader.addAdditionalModules(files)
			}))
		);
		for (const { alias, entries } of chunkEntries) {
			for (const entry of entries) {
				addModuleToManualChunk(alias, entry, manualChunkAliasByEntry);
			}
		}
		return manualChunkAliasByEntry;
	}

	private assignChunkIds(
		chunks: readonly Chunk[],
		inputBase: string,
		addons: Addons,
		bundle: OutputBundleWithPlaceholders
	): void {
		const entryChunks: Chunk[] = [];
		const otherChunks: Chunk[] = [];
		for (const chunk of chunks) {
			(chunk.facadeModule && chunk.facadeModule.isUserDefinedEntryPoint
				? entryChunks
				: otherChunks
			).push(chunk);
		}

		// make sure entry chunk names take precedence with regard to deconflicting
		const chunksForNaming = entryChunks.concat(otherChunks);
		for (const chunk of chunksForNaming) {
			if (this.outputOptions.file) {
				chunk.id = basename(this.outputOptions.file);
			} else if (this.outputOptions.preserveModules) {
				chunk.id = chunk.generateIdPreserveModules(
					inputBase,
					this.outputOptions,
					bundle,
					this.unsetOptions
				);
			} else {
				chunk.id = chunk.generateId(addons, this.outputOptions, bundle, true);
			}
			bundle[chunk.id] = FILE_PLACEHOLDER;
		}
	}

	private assignManualChunks(getManualChunk: GetManualChunk): Map<Module, string> {
		const manualChunkAliasesWithEntry: [alias: string, module: Module][] = [];
		const manualChunksApi = {
			getModuleIds: () => this.graph.modulesById.keys(),
			getModuleInfo: this.graph.getModuleInfo
		};
		for (const module of this.graph.modulesById.values()) {
			if (module instanceof Module) {
				const manualChunkAlias = getManualChunk(module.id, manualChunksApi);
				if (typeof manualChunkAlias === 'string') {
					manualChunkAliasesWithEntry.push([manualChunkAlias, module]);
				}
			}
		}
		manualChunkAliasesWithEntry.sort(([aliasA], [aliasB]) =>
			aliasA > aliasB ? 1 : aliasA < aliasB ? -1 : 0
		);
		const manualChunkAliasByEntry = new Map<Module, string>();
		for (const [alias, module] of manualChunkAliasesWithEntry) {
			addModuleToManualChunk(alias, module, manualChunkAliasByEntry);
		}
		return manualChunkAliasByEntry;
	}

	private finaliseAssets(outputBundle: OutputBundleWithPlaceholders): void {
		for (const file of Object.values(outputBundle)) {
			if (!file.type) {
				warnDeprecation(
					'A plugin is directly adding properties to the bundle object in the "generateBundle" hook. This is deprecated and will be removed in a future Rollup version, please use "this.emitFile" instead.',
					true,
					this.inputOptions
				);
				(file as OutputAsset).type = 'asset';
			}
			if (this.outputOptions.validate && 'code' in file) {
				try {
					this.graph.contextParse(file.code, {
						allowHashBang: true,
						ecmaVersion: 'latest'
					});
				} catch (err: any) {
					this.inputOptions.onwarn(errChunkInvalid(file, err));
				}
			}
		}
		this.pluginDriver.finaliseAssets();
	}

	private async generateChunks(): Promise<Chunk[]> {
		const { manualChunks } = this.outputOptions;
		const manualChunkAliasByEntry =
			typeof manualChunks === 'object'
				? await this.addManualChunks(manualChunks)
				: this.assignManualChunks(manualChunks);
		const chunks: Chunk[] = [];
		const chunkByModule = new Map<Module, Chunk>();
		for (const { alias, modules } of this.outputOptions.inlineDynamicImports
			? [{ alias: null, modules: getIncludedModules(this.graph.modulesById) }]
			: this.outputOptions.preserveModules
			? getIncludedModules(this.graph.modulesById).map(module => ({
					alias: null,
					modules: [module]
			  }))
			: getChunkAssignments(this.graph.entryModules, manualChunkAliasByEntry)) {
			sortByExecutionOrder(modules);
			const chunk = new Chunk(
				modules,
				this.inputOptions,
				this.outputOptions,
				this.unsetOptions,
				this.pluginDriver,
				this.graph.modulesById,
				chunkByModule,
				this.facadeChunkByModule,
				this.includedNamespaces,
				alias
			);
			chunks.push(chunk);
			for (const module of modules) {
				chunkByModule.set(module, chunk);
			}
		}
		for (const chunk of chunks) {
			chunk.link();
		}
		const facades: Chunk[] = [];
		for (const chunk of chunks) {
			facades.push(...chunk.generateFacades());
		}
		return [...chunks, ...facades];
	}

	private prerenderChunks(
		chunks: readonly Chunk[],
		inputBase: string,
		snippets: GenerateCodeSnippets
	): void {
		for (const chunk of chunks) {
			chunk.generateExports();
		}
		for (const chunk of chunks) {
			chunk.preRender(this.outputOptions, inputBase, snippets);
		}
	}
}

function getAbsoluteEntryModulePaths(chunks: readonly Chunk[]): string[] {
	const absoluteEntryModulePaths: string[] = [];
	for (const chunk of chunks) {
		for (const entryModule of chunk.entryModules) {
			if (isAbsolute(entryModule.id)) {
				absoluteEntryModulePaths.push(entryModule.id);
			}
		}
	}
	return absoluteEntryModulePaths;
}

function validateOptionsForMultiChunkOutput(
	outputOptions: NormalizedOutputOptions,
	onWarn: WarningHandler
) {
	if (outputOptions.format === 'umd' || outputOptions.format === 'iife')
		return error(
			errInvalidOption(
				'output.format',
				'outputformat',
				'UMD and IIFE output formats are not supported for code-splitting builds',
				outputOptions.format
			)
		);
	if (typeof outputOptions.file === 'string')
		return error(
			errInvalidOption(
				'output.file',
				'outputdir',
				'when building multiple chunks, the "output.dir" option must be used, not "output.file". To inline dynamic imports, set the "inlineDynamicImports" option'
			)
		);
	if (outputOptions.sourcemapFile)
		return error(
			errInvalidOption(
				'output.sourcemapFile',
				'outputsourcemapfile',
				'"output.sourcemapFile" is only supported for single-file builds'
			)
		);
	if (!outputOptions.amd.autoId && outputOptions.amd.id)
		onWarn(
			errInvalidOption(
				'output.amd.id',
				'outputamd',
				'this option is only properly supported for single-file builds. Use "output.amd.autoId" and "output.amd.basePath" instead'
			)
		);
}

function getIncludedModules(modulesById: ReadonlyMap<string, Module | ExternalModule>): Module[] {
	return [...modulesById.values()].filter(
		(module): module is Module =>
			module instanceof Module &&
			(module.isIncluded() || module.info.isEntry || module.includedDynamicImporters.length > 0)
	);
}

function addModuleToManualChunk(
	alias: string,
	module: Module,
	manualChunkAliasByEntry: Map<Module, string>
): void {
	const existingAlias = manualChunkAliasByEntry.get(module);
	if (typeof existingAlias === 'string' && existingAlias !== alias) {
		return error(errCannotAssignModuleToChunk(module.id, alias, existingAlias));
	}
	manualChunkAliasByEntry.set(module, alias);
}
