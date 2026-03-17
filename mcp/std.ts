import { cosineSimilarity, embedTexts, getVoyageConfig } from "./voyage.js";

const CAT_namespace = 0;
const CAT_container = 1;
const CAT_global_variable = 2;
const CAT_function = 3;
const CAT_primitive = 4;
const CAT_error_set = 5;
const CAT_global_const = 6;
const CAT_alias = 7;
const CAT_type = 8;
const CAT_type_type = 9;
const CAT_type_function = 10;

const LOG_err = 0;
const LOG_warn = 1;
const LOG_info = 2;
const LOG_debug = 3;

const domContent: any = typeof document !== "undefined" ? document.getElementById("content") : null;
const domSearch: any = typeof document !== "undefined" ? document.getElementById("search") : null;
const domErrors: any = typeof document !== "undefined" ? document.getElementById("errors") : null;
const domErrorsText: any =
    typeof document !== "undefined" ? document.getElementById("errorsText") : null;

var searchTimer: any = null;

const curNav = {
    tag: 0,
    decl: null,
    path: null,
};
var curNavSearch = "";

const moduleList: any = [];

var wasm_exports: any = null;

const text_decoder = new TextDecoder();
const text_encoder = new TextEncoder();

declare global {
    interface Window {
        wasm?: any;
    }
}

export function startDocsViewer() {
    const wasm_promise = fetch("main.wasm");
    const sources_promise = fetch("sources.tar").then((response) => {
        if (!response.ok) throw new Error("unable to download sources");
        return response.arrayBuffer();
    });

    WebAssembly.instantiateStreaming(wasm_promise, {
        js: {
            log: (level: any, ptr: any, len: any) => {
                const msg = decodeString(ptr, len);
                switch (level) {
                    case LOG_err:
                        console.error(msg);
                        if (domErrorsText) domErrorsText.textContent += msg + "\n";
                        if (domErrors) domErrors.classList.remove("hidden");
                        break;
                    case LOG_warn:
                        console.warn(msg);
                        break;
                    case LOG_info:
                        console.info(msg);
                        break;
                    case LOG_debug:
                        console.debug(msg);
                        break;
                }
            },
        },
    }).then((obj) => {
        wasm_exports = obj.instance.exports;
        if (typeof window !== "undefined") window.wasm = obj; // for debugging

        sources_promise.then((buffer) => {
            const js_array = new Uint8Array(buffer);
            const ptr = wasm_exports.alloc(js_array.length);
            const wasm_array = new Uint8Array(wasm_exports.memory.buffer, ptr, js_array.length);
            wasm_array.set(js_array);
            wasm_exports.unpack(ptr, js_array.length);

            updateModuleList();

            if (typeof window !== "undefined") {
                window.addEventListener("popstate", onPopState, false);
                window.addEventListener("keydown", onWindowKeyDown, false);
            }
            if (domSearch) {
                domSearch.addEventListener("keydown", onSearchKeyDown, false);
                domSearch.addEventListener("input", onSearchChange, false);
            }
            onHashChange(null);
        });
    });
}

function renderTitle() {
    if (typeof document === "undefined") return;
    const suffix = " - Zig Documentation";
    if (curNavSearch.length > 0) {
        document.title = curNavSearch + " - Search" + suffix;
    } else if (curNav.decl != null) {
        document.title = fullyQualifiedName(curNav.decl) + suffix;
    } else if (curNav.path != null) {
        document.title = curNav.path + suffix;
    } else {
        document.title = moduleList[0] + suffix;
    }
}

function render() {
    renderTitle();
    if (domContent) domContent.textContent = "";

    if (curNavSearch !== "") return renderSearch();

    switch (curNav.tag) {
        case 0:
            return renderHome();
        case 1:
            if (curNav.decl == null) {
                return renderNotFound();
            } else {
                return renderDecl(curNav.decl);
            }
        case 2:
            return renderSource(curNav.path);
        default:
            throw new Error("invalid navigation state");
    }
}

function renderHome() {
    if (moduleList.length == 0) {
        if (domContent) domContent.textContent = "# Error\n\nsources.tar contains no modules";
        return;
    }
    return renderModule(0);
}

function renderModule(pkg_index: any) {
    const root_decl = wasm_exports.find_module_root(pkg_index);
    return renderDecl(root_decl);
}

function renderDecl(decl_index: any) {
    let current = decl_index;
    const seen = new Set<number>();
    while (true) {
        const category = wasm_exports.categorize_decl(current, 0);
        switch (category) {
            case CAT_namespace:
            case CAT_container:
                return renderNamespacePage(current);
            case CAT_global_variable:
            case CAT_primitive:
            case CAT_global_const:
            case CAT_type:
            case CAT_type_type:
                return renderGlobal(current);
            case CAT_function:
                return renderFunction(current);
            case CAT_type_function:
                return renderTypeFunction(current);
            case CAT_error_set:
                return renderErrorSetPage(current);
            case CAT_alias: {
                if (seen.has(current)) return renderNotFound();
                seen.add(current);
                const aliasee = wasm_exports.get_aliasee();
                if (aliasee === -1) return renderNotFound();
                current = aliasee;
                continue;
            }
            default:
                throw new Error("unrecognized category " + category);
        }
    }
}

function renderSource(path: any) {
    const decl_index = findFileRoot(path);
    if (decl_index == null) return renderNotFound();

    let markdown = "";
    markdown += "# " + path + "\n\n";
    markdown += unwrapString(wasm_exports.decl_source_html(decl_index));

    if (domContent) domContent.textContent = markdown;
    return markdown;
}

function renderNamespacePage(decl_index: any) {
    let markdown = "";

    // Add title
    const name = unwrapString(wasm_exports.decl_category_name(decl_index));
    markdown += "# " + name + "\n\n";

    // Add documentation
    const docs = unwrapString(wasm_exports.decl_docs_html(decl_index, false));
    if (docs.length > 0) {
        markdown += docs + "\n\n";
    }

    // Add namespace content
    const members = namespaceMembers(decl_index, false).slice();
    const fields = declFields(decl_index).slice();
    markdown += renderNamespaceMarkdown(decl_index, members, fields);

    if (domContent) domContent.textContent = markdown;
    return markdown;
}

function renderFunction(decl_index: any) {
    let markdown = "";

    // Add title
    const name = unwrapString(wasm_exports.decl_category_name(decl_index));
    markdown += "# " + name + "\n";

    // Add documentation
    const docs = unwrapString(wasm_exports.decl_docs_html(decl_index, false));
    if (docs.length > 0) {
        markdown += "\n" + docs;
    }

    // Add function prototype
    const proto = unwrapString(wasm_exports.decl_fn_proto_html(decl_index, false));
    if (proto.length > 0) {
        markdown += "\n\n## Function Signature\n\n" + proto;
    }

    // Add parameters
    const params = declParams(decl_index).slice();
    if (params.length > 0) {
        markdown += "\n\n## Parameters\n";
        for (let i = 0; i < params.length; i++) {
            const param_html = unwrapString(wasm_exports.decl_param_html(decl_index, params[i]));
            markdown += "\n" + param_html;
        }
    }

    // Add errors
    const errorSetNode = fnErrorSet(decl_index);
    if (errorSetNode != null) {
        const base_decl = wasm_exports.fn_error_set_decl(decl_index, errorSetNode);
        const errorList = errorSetNodeList(decl_index, errorSetNode);
        if (errorList != null && errorList.length > 0) {
            markdown += "\n\n## Errors\n";
            for (let i = 0; i < errorList.length; i++) {
                const error_html = unwrapString(wasm_exports.error_html(base_decl, errorList[i]));
                markdown += "\n" + error_html;
            }
        }
    }

    // Add doctest
    const doctest = unwrapString(wasm_exports.decl_doctest_html(decl_index));
    if (doctest.length > 0) {
        markdown += "\n\n## Example Usage\n\n" + doctest;
    }

    // Add source code
    const source = unwrapString(wasm_exports.decl_source_html(decl_index));
    if (source.length > 0) {
        markdown += "\n\n## Source Code\n\n" + source;
    }

    if (domContent) domContent.textContent = markdown;
    return markdown;
}

function renderGlobal(decl_index: any) {
    let markdown = "";

    // Add title
    const name = unwrapString(wasm_exports.decl_category_name(decl_index));
    markdown += "# " + name + "\n\n";

    // Add documentation
    const docs = unwrapString(wasm_exports.decl_docs_html(decl_index, true));
    if (docs.length > 0) {
        markdown += docs + "\n\n";
    }

    // Add source code
    const source = unwrapString(wasm_exports.decl_source_html(decl_index));
    if (source.length > 0) {
        markdown += "## Source Code\n\n" + source + "\n\n";
    }

    if (domContent) domContent.textContent = markdown;
    return markdown;
}

function renderTypeFunction(decl_index: any) {
    let markdown = "";

    // Add title
    const name = unwrapString(wasm_exports.decl_category_name(decl_index));
    markdown += "# " + name + "\n\n";

    // Add documentation
    const docs = unwrapString(wasm_exports.decl_docs_html(decl_index, false));
    if (docs.length > 0) {
        markdown += docs + "\n\n";
    }

    // Add parameters
    const params = declParams(decl_index).slice();
    if (params.length > 0) {
        markdown += "## Parameters\n\n";
        for (let i = 0; i < params.length; i++) {
            const param_html = unwrapString(wasm_exports.decl_param_html(decl_index, params[i]));
            markdown += param_html + "\n\n";
        }
    }

    // Add doctest
    const doctest = unwrapString(wasm_exports.decl_doctest_html(decl_index));
    if (doctest.length > 0) {
        markdown += "## Example Usage\n\n" + doctest + "\n\n";
    }

    // Add namespace content or source
    const members = unwrapSlice32(wasm_exports.type_fn_members(decl_index, false)).slice();
    const fields = unwrapSlice32(wasm_exports.type_fn_fields(decl_index)).slice();
    if (members.length !== 0 || fields.length !== 0) {
        markdown += renderNamespaceMarkdown(decl_index, members, fields);
    } else {
        const source = unwrapString(wasm_exports.decl_source_html(decl_index));
        if (source.length > 0) {
            markdown += "## Source Code\n\n" + source + "\n\n";
        }
    }

    if (domContent) domContent.textContent = markdown;
    return markdown;
}

function renderErrorSetPage(decl_index: any) {
    let markdown = "";

    // Add title
    const name = unwrapString(wasm_exports.decl_category_name(decl_index));
    markdown += "# " + name + "\n\n";

    // Add documentation
    const docs = unwrapString(wasm_exports.decl_docs_html(decl_index, false));
    if (docs.length > 0) {
        markdown += docs + "\n\n";
    }

    // Add errors
    const errorSetList = declErrorSet(decl_index).slice();
    if (errorSetList != null && errorSetList.length > 0) {
        markdown += "## Errors\n\n";
        for (let i = 0; i < errorSetList.length; i++) {
            const error_html = unwrapString(wasm_exports.error_html(decl_index, errorSetList[i]));
            markdown += error_html + "\n\n";
        }
    }

    if (domContent) domContent.textContent = markdown;
    return markdown;
}

function renderNavMarkdown(decl_index: any) {
    let markdown = "";
    const list = [];

    // Walk backwards through decl parents
    let decl_it = decl_index;
    while (decl_it != null) {
        list.push(declIndexName(decl_it));
        decl_it = declParent(decl_it);
    }

    // Walk backwards through file path segments
    if (decl_index != null) {
        const file_path = fullyQualifiedName(decl_index);
        const parts = file_path.split(".");
        parts.pop(); // skip last
        for (let i = parts.length - 1; i >= 0; i--) {
            if (parts[i]) {
                list.push(parts[i]);
            }
        }
    }

    list.reverse();

    if (list.length > 0) {
        markdown += "*Navigation: " + list.join(" > ") + "*\n\n";
    }

    return markdown;
}

function renderNamespaceMarkdown(base_decl: any, members: any, fields: any) {
    let markdown = "";

    const typesList = [];
    const namespacesList = [];
    const errSetsList = [];
    const fnsList = [];
    const varsList = [];
    const valsList = [];

    // Categorize members
    for (let i = 0; i < members.length; i++) {
        let member = members[i];
        const original = member;
        const seen = new Set<number>();
        while (true) {
            const member_category = wasm_exports.categorize_decl(member, 0);
            switch (member_category) {
                case CAT_namespace:
                    namespacesList.push({ original: original, member: member });
                    break;
                case CAT_container:
                    typesList.push({ original: original, member: member });
                    break;
                case CAT_global_variable:
                    varsList.push(member);
                    break;
                case CAT_function:
                    fnsList.push(member);
                    break;
                case CAT_type:
                case CAT_type_type:
                case CAT_type_function:
                    typesList.push({ original: original, member: member });
                    break;
                case CAT_error_set:
                    errSetsList.push({ original: original, member: member });
                    break;
                case CAT_global_const:
                case CAT_primitive:
                    valsList.push({ original: original, member: member });
                    break;
                case CAT_alias: {
                    if (seen.has(member)) {
                        valsList.push({ original: original, member: member });
                        break;
                    }
                    seen.add(member);
                    member = wasm_exports.get_aliasee();
                    continue;
                }
                default:
                    throw new Error("unknown category: " + member_category);
            }
            break;
        }
    }

    // Render each category
    if (typesList.length > 0) {
        markdown += "## Types\n\n";
        for (let i = 0; i < typesList.length; i++) {
            const name = declIndexName(typesList[i].original);
            markdown += "- " + name + "\n";
        }
        markdown += "\n";
    }

    if (namespacesList.length > 0) {
        markdown += "## Namespaces\n\n";
        for (let i = 0; i < namespacesList.length; i++) {
            const name = declIndexName(namespacesList[i].original);
            markdown += "- " + name + "\n";
        }
        markdown += "\n";
    }

    if (errSetsList.length > 0) {
        markdown += "## Error Sets\n\n";
        for (let i = 0; i < errSetsList.length; i++) {
            const name = declIndexName(errSetsList[i].original);
            markdown += "- " + name + "\n";
        }
        markdown += "\n";
    }

    if (fnsList.length > 0) {
        markdown += "## Functions\n\n";
        for (let i = 0; i < fnsList.length; i++) {
            const decl = fnsList[i];
            const name = declIndexName(decl);
            const proto = unwrapString(wasm_exports.decl_fn_proto_html(decl, true));
            const docs = unwrapString(wasm_exports.decl_docs_html(decl, true));

            markdown += "### " + name + "\n\n";
            if (proto.length > 0) {
                markdown += proto + "\n\n";
            }
            if (docs.length > 0) {
                markdown += docs + "\n\n";
            }
        }
    }

    if (fields.length > 0) {
        markdown += "## Fields\n\n";
        for (let i = 0; i < fields.length; i++) {
            const field_html = unwrapString(wasm_exports.decl_field_html(base_decl, fields[i]));
            markdown += field_html + "\n\n";
        }
    }

    if (varsList.length > 0) {
        markdown += "## Global Variables\n\n";
        for (let i = 0; i < varsList.length; i++) {
            const decl = varsList[i];
            const name = declIndexName(decl);
            const type_html = unwrapString(wasm_exports.decl_type_html(decl));
            const docs = unwrapString(wasm_exports.decl_docs_html(decl, true));

            markdown += "### " + name + "\n\n";
            if (type_html.length > 0) {
                markdown += "Type: " + type_html + "\n\n";
            }
            if (docs.length > 0) {
                markdown += docs + "\n\n";
            }
        }
    }

    if (valsList.length > 0) {
        markdown += "## Values\n\n";
        for (let i = 0; i < valsList.length; i++) {
            const original_decl = valsList[i].original;
            const decl = valsList[i].member;
            const name = declIndexName(original_decl);
            const type_html = unwrapString(wasm_exports.decl_type_html(decl));
            const docs = unwrapString(wasm_exports.decl_docs_html(decl, true));

            markdown += "### " + name + "\n\n";
            if (type_html.length > 0) {
                markdown += "Type: " + type_html + "\n\n";
            }
            if (docs.length > 0) {
                markdown += docs + "\n\n";
            }
        }
    }

    return markdown;
}

function renderNotFound() {
    const markdown = "# Error\n\nDeclaration not found.";
    if (domContent) domContent.textContent = markdown;
    return markdown;
}

function renderSearch() {
    const ignoreCase = curNavSearch.toLowerCase() === curNavSearch;
    const results = executeQuery(curNavSearch, ignoreCase);

    let markdown = "# Search Results\n\n";
    markdown += 'Query: "' + curNavSearch + '"\n\n';

    if (results.length > 0) {
        markdown += "Found " + results.length + " results:\n\n";
        for (let i = 0; i < results.length; i++) {
            const match = results[i];
            const full_name = fullyQualifiedName(match);
            markdown += "- " + full_name + "\n";
        }
    } else {
        markdown += "No results found.\n\nPress escape to exit search.";
    }

    if (domContent) domContent.textContent = markdown;
    return markdown;
}

// Event handlers and utility functions (unchanged from original)
function updateCurNav(location_hash: any) {
    curNav.tag = 0;
    curNav.decl = null;
    curNav.path = null;
    curNavSearch = "";

    if (location_hash.length > 1 && location_hash[0] === "#") {
        const query = location_hash.substring(1);
        const qpos = query.indexOf("?");
        let nonSearchPart;
        if (qpos === -1) {
            nonSearchPart = query;
        } else {
            nonSearchPart = query.substring(0, qpos);
            curNavSearch = decodeURIComponent(query.substring(qpos + 1));
        }

        if (nonSearchPart.length > 0) {
            const source_mode = nonSearchPart.startsWith("src/");
            if (source_mode) {
                curNav.tag = 2;
                curNav.path = nonSearchPart.substring(4);
            } else {
                curNav.tag = 1;
                curNav.decl = findDecl(nonSearchPart);
            }
        }
    }
}

function onHashChange(state: any) {
    if (typeof history !== "undefined") history.replaceState({}, "");
    if (typeof location !== "undefined") navigate(location.hash);
    if (state == null && typeof window !== "undefined") window.scrollTo({ top: 0 });
}

function onPopState(ev: any) {
    onHashChange(ev.state);
}

function navigate(location_hash: any) {
    updateCurNav(location_hash);
    if (domSearch && domSearch.value !== curNavSearch) {
        domSearch.value = curNavSearch;
    }
    render();
}

function onSearchKeyDown(ev: any) {
    switch (ev.code) {
        case "Enter":
            if (ev.shiftKey || ev.ctrlKey || ev.altKey) return;
            clearAsyncSearch();
            if (typeof location !== "undefined") location.hash = computeSearchHash();
            ev.preventDefault();
            ev.stopPropagation();
            return;
        case "Escape":
            if (ev.shiftKey || ev.ctrlKey || ev.altKey) return;
            if (domSearch) {
                domSearch.value = "";
                domSearch.blur();
            }
            ev.preventDefault();
            ev.stopPropagation();
            startSearch();
            return;
        default:
            ev.stopPropagation();
            return;
    }
}

function onSearchChange(ev: any) {
    startAsyncSearch();
}

function onWindowKeyDown(ev: any) {
    switch (ev.code) {
        case "KeyS":
            if (ev.shiftKey || ev.ctrlKey || ev.altKey) return;
            if (domSearch) {
                domSearch.focus();
                domSearch.select();
            }
            ev.preventDefault();
            ev.stopPropagation();
            startAsyncSearch();
            break;
    }
}

function clearAsyncSearch() {
    if (searchTimer != null) {
        clearTimeout(searchTimer);
        searchTimer = null;
    }
}

function startAsyncSearch() {
    clearAsyncSearch();
    searchTimer = setTimeout(startSearch, 10);
}

function computeSearchHash() {
    if (typeof location === "undefined" || !domSearch) return "";
    const oldWatHash = location.hash;
    const oldHash = oldWatHash.startsWith("#") ? oldWatHash : "#" + oldWatHash;
    const parts = oldHash.split("?");
    const newPart2 = domSearch.value === "" ? "" : "?" + domSearch.value;
    return parts[0] + newPart2;
}

function startSearch() {
    clearAsyncSearch();
    navigate(computeSearchHash());
}

function updateModuleList() {
    moduleList.length = 0;
    for (let i = 0; ; i += 1) {
        const name = unwrapString(wasm_exports.module_name(i));
        if (name.length == 0) break;
        moduleList.push(name);
    }
}

// Utility functions (unchanged from original)
function decodeString(ptr: any, len: any) {
    if (len === 0) return "";
    return text_decoder.decode(new Uint8Array(wasm_exports.memory.buffer, ptr, len));
}

function unwrapString(bigint: any) {
    const ptr = Number(bigint & 0xffffffffn);
    const len = Number(bigint >> 32n);
    return decodeString(ptr, len);
}

function fullyQualifiedName(decl_index: any) {
    return unwrapString(wasm_exports.decl_fqn(decl_index));
}

function declIndexName(decl_index: any) {
    return unwrapString(wasm_exports.decl_name(decl_index));
}

function setQueryString(s: any) {
    const jsArray = text_encoder.encode(s);
    const len = jsArray.length;
    const ptr = wasm_exports.query_begin(len);
    const wasmArray = new Uint8Array(wasm_exports.memory.buffer, ptr, len);
    wasmArray.set(jsArray);
}

function executeQuery(query_string: any, ignore_case: any) {
    setQueryString(query_string);
    const ptr = wasm_exports.query_exec(ignore_case);
    const head = new Uint32Array(wasm_exports.memory.buffer, ptr, 1);
    const len = head[0];
    return new Uint32Array(wasm_exports.memory.buffer, ptr + 4, len);
}

function namespaceMembers(decl_index: any, include_private: any) {
    return unwrapSlice32(wasm_exports.namespace_members(decl_index, include_private));
}

function declFields(decl_index: any) {
    return unwrapSlice32(wasm_exports.decl_fields(decl_index));
}

function declParams(decl_index: any) {
    return unwrapSlice32(wasm_exports.decl_params(decl_index));
}

function declErrorSet(decl_index: any) {
    return unwrapSlice64(wasm_exports.decl_error_set(decl_index));
}

function errorSetNodeList(base_decl: any, err_set_node: any) {
    return unwrapSlice64(wasm_exports.error_set_node_list(base_decl, err_set_node));
}

function unwrapSlice32(bigint: any) {
    const ptr = Number(bigint & 0xffffffffn);
    const len = Number(bigint >> 32n);
    if (len === 0) return [];
    return new Uint32Array(wasm_exports.memory.buffer, ptr, len);
}

function unwrapSlice64(bigint: any) {
    const ptr = Number(bigint & 0xffffffffn);
    const len = Number(bigint >> 32n);
    if (len === 0) return [];
    return new BigUint64Array(wasm_exports.memory.buffer, ptr, len);
}

function findDecl(fqn: any) {
    setInputString(fqn);
    const result = wasm_exports.find_decl();
    if (result === -1) return null;
    return result;
}

function findFileRoot(path: any) {
    setInputString(path);
    const result = wasm_exports.find_file_root();
    if (result === -1) return null;
    return result;
}

function declParent(decl_index: any) {
    const result = wasm_exports.decl_parent(decl_index);
    if (result === -1) return null;
    return result;
}

function fnErrorSet(decl_index: any) {
    const result = wasm_exports.fn_error_set(decl_index);
    if (result === 0) return null;
    return result;
}

function setInputString(s: any) {
    const jsArray = text_encoder.encode(s);
    const len = jsArray.length;
    const ptr = wasm_exports.set_input_string(len);
    const wasmArray = new Uint8Array(wasm_exports.memory.buffer, ptr, len);
    wasmArray.set(jsArray);
}

interface StdLibSearchOptions {
    zigVersion?: string;
    docSource?: string;
}

interface EmbeddingDoc {
    decl: number;
    fqn: string;
    text: string;
}

interface EmbeddingCacheFile {
    version: 1;
    model: string;
    sourceHash: string;
    zigVersion: string;
    docSource: string;
    docs: EmbeddingDoc[];
    vectors: number[][];
}

let inMemoryEmbeddingCache: EmbeddingCacheFile | null = null;

interface SourceDeclEntry {
    name: string;
    path: string;
    line: number;
    preview: string;
}

interface SourceFileEntry {
    path: string;
    text: string;
    lowerText: string;
}

interface SourceTextIndex {
    files: SourceFileEntry[];
    decls: SourceDeclEntry[];
}

let cachedSourceTextIndex: SourceTextIndex | null = null;
let cachedSourceTextRef: Uint8Array<ArrayBuffer> | null = null;

async function initWasmRuntime(
    wasmPath: string | Uint8Array,
    stdSources: Uint8Array<ArrayBuffer>,
): Promise<void> {
    const fs = await import("node:fs");
    const wasmBytes = typeof wasmPath === "string" ? fs.readFileSync(wasmPath) : wasmPath;

    const wasmModule = await WebAssembly.instantiate(wasmBytes, {
        js: {
            log: (level: any, ptr: any, len: any) => {
                const msg = decodeString(ptr, len);
                if (level === LOG_err) {
                    throw new Error(msg);
                }
            },
        },
    });

    const exports = (wasmModule as any).instance.exports as any;
    wasm_exports = exports;

    const ptr = exports.alloc(stdSources.length);
    const wasmArray = new Uint8Array(exports.memory.buffer, ptr, stdSources.length);
    wasmArray.set(stdSources);
    exports.unpack(ptr, stdSources.length);
}

function collectDeclsForEmbeddings(): number[] {
    const seen = new Set<number>();
    const result: number[] = [];

    function walk(decl: number) {
        if (decl < 0 || seen.has(decl)) {
            return;
        }
        seen.add(decl);
        result.push(decl);

        const category = wasm_exports.categorize_decl(decl, 0);
        if (category === CAT_alias) {
            const aliasee = wasm_exports.get_aliasee();
            if (aliasee !== -1) {
                walk(aliasee);
            }
            return;
        }

        if (category === CAT_namespace || category === CAT_container) {
            const members = namespaceMembers(decl, false).slice();
            for (let i = 0; i < members.length; i++) {
                walk(members[i]);
            }
            return;
        }

        if (category === CAT_type_function) {
            const members = unwrapSlice32(wasm_exports.type_fn_members(decl, false)).slice();
            for (let i = 0; i < members.length; i++) {
                walk(members[i]);
            }
        }
    }

    for (let i = 0; ; i++) {
        const name = unwrapString(wasm_exports.module_name(i));
        if (name.length === 0) {
            break;
        }
        const root = wasm_exports.find_module_root(i);
        if (root !== -1) {
            walk(root);
        }
    }

    return result;
}

function stripMarkdown(input: string): string {
    return input
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
        .replace(/[#*_>~-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function parseTarOctal(raw: string): number {
    const cleaned = raw.replace(/\0/g, "").trim();
    if (!cleaned) return 0;
    const parsed = Number.parseInt(cleaned, 8);
    return Number.isFinite(parsed) ? parsed : 0;
}

function parseSourcesTar(stdSources: Uint8Array<ArrayBuffer>): SourceFileEntry[] {
    const files: SourceFileEntry[] = [];
    let offset = 0;

    while (offset + 512 <= stdSources.length) {
        const header = stdSources.subarray(offset, offset + 512);
        let emptyHeader = true;
        for (let i = 0; i < 512; i++) {
            if (header[i] !== 0) {
                emptyHeader = false;
                break;
            }
        }
        if (emptyHeader) break;

        const name = text_decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, "").trim();
        const sizeRaw = text_decoder
            .decode(header.subarray(124, 136))
            .replace(/\0.*$/, "")
            .trim();
        const prefix = text_decoder
            .decode(header.subarray(345, 500))
            .replace(/\0.*$/, "")
            .trim();
        const size = parseTarOctal(sizeRaw);
        const fullPath = prefix.length > 0 ? `${prefix}/${name}` : name;

        const contentStart = offset + 512;
        const contentEnd = contentStart + size;
        if (size > 0 && contentEnd <= stdSources.length && fullPath.endsWith(".zig")) {
            const text = text_decoder.decode(stdSources.subarray(contentStart, contentEnd));
            files.push({ path: fullPath, text, lowerText: text.toLowerCase() });
        }

        const paddedSize = Math.ceil(size / 512) * 512;
        offset = contentStart + paddedSize;
    }

    return files;
}

function buildSourceTextIndex(stdSources: Uint8Array<ArrayBuffer>): SourceTextIndex {
    if (cachedSourceTextIndex && cachedSourceTextRef === stdSources) {
        return cachedSourceTextIndex;
    }

    const files = parseSourcesTar(stdSources);
    const decls: SourceDeclEntry[] = [];
    const declRegex = /^\s*(?:pub\s+)?(?:const|var|fn)\s+([A-Za-z_][A-Za-z0-9_]*)/;

    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
        const file = files[fileIndex];
        const lines = file.text.split("\n");
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            const line = lines[lineIndex];
            const match = line.match(declRegex);
            if (!match) continue;
            decls.push({
                name: match[1],
                path: file.path,
                line: lineIndex + 1,
                preview: line.trim(),
            });
        }
    }

    cachedSourceTextRef = stdSources;
    cachedSourceTextIndex = { files, decls };
    return cachedSourceTextIndex;
}

function fallbackSearchStdLib(stdSources: Uint8Array<ArrayBuffer>, query: string, limit: number): string {
    const index = buildSourceTextIndex(stdSources);
    const queryLower = query.toLowerCase().trim();

    const scored = index.decls
        .map((decl) => {
            const nameLower = decl.name.toLowerCase();
            const pathLower = decl.path.toLowerCase();
            let score = 0;

            if (nameLower === queryLower) score += 1000;
            else if (nameLower.startsWith(queryLower)) score += 700;
            else if (nameLower.includes(queryLower)) score += 450;

            if (pathLower.includes(queryLower)) score += 150;

            return { decl, score };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score);

    let markdown = `# Search Results\n\nQuery: "${query}"\n\n`;
    markdown += `_Fallback mode: text index (parser-incompatible Zig version)_\n\n`;

    if (scored.length === 0) {
        markdown += "No results found.";
        return markdown;
    }

    const limited = scored.slice(0, limit);
    markdown += `Found ${scored.length} results (showing ${limited.length}):\n\n`;
    for (let i = 0; i < limited.length; i++) {
        const entry = limited[i].decl;
        markdown += `- std.${entry.name} (${entry.path}:${entry.line})\n`;
    }

    return markdown;
}

function fallbackGetStdLibItem(
    stdSources: Uint8Array<ArrayBuffer>,
    name: string,
    getSourceFile: boolean,
): string {
    const index = buildSourceTextIndex(stdSources);

    if (getSourceFile) {
        const normalized = name.replace(/^src\//, "");
        const matchedFile =
            index.files.find((file) => file.path === normalized) ||
            index.files.find((file) => file.path.endsWith(`/${normalized}`)) ||
            index.files.find((file) => file.path.endsWith(name));

        if (!matchedFile) {
            return `# Error\n\nCould not find source file for "${name}" in fallback mode.`;
        }

        return `# ${matchedFile.path}\n\n${matchedFile.text}`;
    }

    const target = name.split(".").pop()?.trim() || name.trim();
    const targetLower = target.toLowerCase();
    const ranked = index.decls
        .map((decl) => {
            const declLower = decl.name.toLowerCase();
            let score = 0;
            if (declLower === targetLower) score += 1000;
            else if (declLower.startsWith(targetLower)) score += 700;
            else if (declLower.includes(targetLower)) score += 450;
            return { decl, score };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score);

    if (ranked.length === 0) {
        return `# Error\n\nDeclaration "${name}" not found (fallback mode).`;
    }

    const best = ranked[0].decl;
    const file = index.files.find((entry) => entry.path === best.path);
    if (!file) {
        return `# Error\n\nDeclaration "${name}" matched, but source file could not be loaded.`;
    }

    const lines = file.text.split("\n");
    const startLine = Math.max(1, best.line - 20);
    const endLine = Math.min(lines.length, best.line + 80);
    const snippet = lines.slice(startLine - 1, endLine).join("\n");

    let markdown = `# ${name}\n\n`;
    markdown += `_Fallback mode: text index (parser-incompatible Zig version)_\n\n`;
    markdown += `Match: ${best.path}:${best.line}\n\n`;
    markdown += "```zig\n";
    markdown += snippet;
    markdown += "\n```\n";
    return markdown;
}

function buildDeclEmbeddingText(decl: number): EmbeddingDoc {
    const category = wasm_exports.categorize_decl(decl, 0);
    const fqn = fullyQualifiedName(decl);
    const name = declIndexName(decl);
    const docs = unwrapString(wasm_exports.decl_docs_html(decl, true));
    const proto =
        category === CAT_function || category === CAT_type_function
            ? unwrapString(wasm_exports.decl_fn_proto_html(decl, true))
            : "";
    const typeInfo =
        category === CAT_global_variable ||
        category === CAT_global_const ||
        category === CAT_primitive ||
        category === CAT_type ||
        category === CAT_type_type
            ? unwrapString(wasm_exports.decl_type_html(decl))
            : "";
    const source = unwrapString(wasm_exports.decl_source_html(decl)).slice(0, 1200);

    const text = stripMarkdown(`${fqn}\n${name}\n${proto}\n${typeInfo}\n${docs}\n${source}`).slice(
        0,
        4000,
    );

    return { decl, fqn, text };
}

function tryBuildDeclEmbeddingText(decl: number): EmbeddingDoc | null {
    try {
        return buildDeclEmbeddingText(decl);
    } catch {
        return null;
    }
}

async function getEmbeddingCachePath(
    zigVersion: string,
    docSource: string,
    model: string,
): Promise<string> {
    const envPathsMod = await import("env-paths");
    const path = await import("node:path");
    const paths = envPathsMod.default("zigsm", { suffix: "" });
    const safeModel = model.replace(/[^a-zA-Z0-9._-]+/g, "-");
    return path.join(paths.cache, zigVersion, `std-embeddings-${docSource}-${safeModel}.json`);
}

async function hashStdSources(stdSources: Uint8Array<ArrayBuffer>): Promise<string> {
    const crypto = await import("node:crypto");
    return crypto.createHash("sha256").update(stdSources).digest("hex");
}

async function loadEmbeddingCache(cachePath: string): Promise<EmbeddingCacheFile | null> {
    const fs = await import("node:fs");
    if (!fs.existsSync(cachePath)) {
        return null;
    }
    try {
        const raw = fs.readFileSync(cachePath, "utf8");
        return JSON.parse(raw) as EmbeddingCacheFile;
    } catch {
        return null;
    }
}

async function saveEmbeddingCache(cachePath: string, data: EmbeddingCacheFile): Promise<void> {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(cachePath, JSON.stringify(data));
}

async function getOrBuildEmbeddingCache(
    wasmPath: string | Uint8Array,
    stdSources: Uint8Array<ArrayBuffer>,
    options: StdLibSearchOptions,
): Promise<EmbeddingCacheFile | null> {
    const voyage = getVoyageConfig();
    if (!voyage) {
        return null;
    }

    const zigVersion = options.zigVersion || "master";
    const docSource = options.docSource || "local";

    if (
        inMemoryEmbeddingCache &&
        inMemoryEmbeddingCache.model === voyage.model &&
        inMemoryEmbeddingCache.zigVersion === zigVersion &&
        inMemoryEmbeddingCache.docSource === docSource
    ) {
        return inMemoryEmbeddingCache;
    }

    const sourceHash = await hashStdSources(stdSources);
    const cachePath = await getEmbeddingCachePath(zigVersion, docSource, voyage.model);
    const existing = await loadEmbeddingCache(cachePath);

    if (
        existing &&
        existing.version === 1 &&
        existing.model === voyage.model &&
        existing.sourceHash === sourceHash &&
        existing.zigVersion === zigVersion &&
        existing.docSource === docSource &&
        existing.docs.length === existing.vectors.length
    ) {
        inMemoryEmbeddingCache = existing;
        return existing;
    }

    const decls = collectDeclsForEmbeddings();
    const docs: EmbeddingDoc[] = [];
    for (let i = 0; i < decls.length; i++) {
        const doc = tryBuildDeclEmbeddingText(decls[i]);
        if (doc && doc.text.length > 0) {
            docs.push(doc);
        }
    }

    if (docs.length === 0) {
        return null;
    }

    const vectors = await embedTexts(
        docs.map((doc) => doc.text),
        voyage,
        "document",
    );

    const built: EmbeddingCacheFile = {
        version: 1,
        model: voyage.model,
        sourceHash,
        zigVersion,
        docSource,
        docs,
        vectors,
    };

    await saveEmbeddingCache(cachePath, built);
    inMemoryEmbeddingCache = built;
    return built;
}

function buildHybridRanking(
    lexicalDecls: number[],
    semanticDecls: number[],
    maxResults: number,
): number[] {
    const scores = new Map<number, number>();

    for (let i = 0; i < lexicalDecls.length; i++) {
        const decl = lexicalDecls[i];
        const score = 1 / (20 + i);
        scores.set(decl, (scores.get(decl) || 0) + score);
    }

    for (let i = 0; i < semanticDecls.length; i++) {
        const decl = semanticDecls[i];
        const score = 2 / (20 + i);
        scores.set(decl, (scores.get(decl) || 0) + score);
    }

    return Array.from(scores.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxResults)
        .map(([decl]) => decl);
}

export async function searchStdLib(
    wasmPath: string | Uint8Array,
    stdSources: Uint8Array<ArrayBuffer>,
    query: string,
    limit: number = 20,
    options: StdLibSearchOptions = {},
): Promise<string> {
    try {
        await initWasmRuntime(wasmPath, stdSources);
    } catch {
        return fallbackSearchStdLib(stdSources, query, limit);
    }

    const ignoreCase = query.toLowerCase() === query;
    const lexicalResults = Array.from(executeQuery(query, ignoreCase));
    let mergedResults = lexicalResults;

    try {
        const voyage = getVoyageConfig();
        if (voyage) {
            const cache = await getOrBuildEmbeddingCache(wasmPath, stdSources, options);
            if (cache && cache.docs.length > 0) {
                const queryVector = (await embedTexts([query], voyage, "query"))[0];
                const semanticResults = cache.docs
                    .map((doc, i) => ({ decl: doc.decl, score: cosineSimilarity(queryVector, cache.vectors[i]) }))
                    .sort((a, b) => b.score - a.score)
                    .slice(0, Math.max(limit * 8, 120))
                    .map((item) => item.decl);

                const lexicalTop = lexicalResults.slice(0, Math.max(limit * 8, 120));
                mergedResults = buildHybridRanking(lexicalTop, semanticResults, Math.max(limit * 8, 120));
            }
        }
    } catch {
        mergedResults = lexicalResults;
    }

    let markdown = `# Search Results\n\nQuery: "${query}"\n\n`;

    if (mergedResults.length > 0) {
        const limitedResults = mergedResults.slice(0, limit);
        markdown += `Found ${mergedResults.length} results (showing ${limitedResults.length}):\n\n`;
        for (let i = 0; i < limitedResults.length; i++) {
            const match = limitedResults[i];
            const full_name = fullyQualifiedName(match);
            markdown += `- ${full_name}\n`;
        }
    } else {
        markdown += "No results found.";
    }

    return markdown;
}

export async function getStdLibItem(
    wasmPath: string | Uint8Array,
    stdSources: Uint8Array<ArrayBuffer>,
    name: string,
    getSourceFile: boolean = false,
): Promise<string> {
    try {
        await initWasmRuntime(wasmPath, stdSources);
    } catch {
        return fallbackGetStdLibItem(stdSources, name, getSourceFile);
    }

    const exports = wasm_exports;

    const decl_index = findDecl(name);
    if (decl_index === null) {
        return `# Error\n\nDeclaration "${name}" not found.`;
    }

    if (getSourceFile) {
        // Resolve aliases by decl index
        let cur = decl_index;
        const seen = new Set<number>();
        while (true) {
            const cat = exports.categorize_decl(cur, 0);
            if (cat !== CAT_alias) break;
            if (seen.has(cur)) break; // cycle guard
            seen.add(cur);
            const next = exports.get_aliasee();
            if (next === -1 || next === cur) break;
            cur = next;
        }

        const filePath = unwrapString(wasm_exports.decl_file_path(cur));
        if (filePath && filePath.length > 0) {
            const fileDecl = findFileRoot(filePath);
            if (fileDecl !== null) {
                let markdown = "";
                markdown += "# " + filePath + "\n\n";
                markdown += unwrapString(wasm_exports.decl_source_html(fileDecl));
                return markdown;
            }
        }
        return `# Error\n\nCould not find source file for "${name}".`;
    }

    return renderDecl(decl_index);
}
