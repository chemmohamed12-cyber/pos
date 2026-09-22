"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var StagedActivationService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.StagedActivationService = exports.RollbackFailedSafeError = void 0;
const common_1 = require("@nestjs/common");
const child_process_1 = require("child_process");
const util_1 = require("util");
const promises_1 = require("fs/promises");
const fs_1 = require("fs");
const path_1 = require("path");
const app_config_service_1 = require("../configuration/app-config.service");
const release_slots_1 = require("./release-slots");
const dependency_check_1 = require("./dependency-check");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
const BUNDLE_REF_RE = /(?:src|href)\s*=\s*["']([^"']*\/assets\/[^"']+\.(?:js|css)[^"']*)["']/gi;
class RollbackFailedSafeError extends Error {
    stage;
    constructor(message, stage) {
        super(message);
        this.stage = stage;
        this.name = 'RollbackFailedSafeError';
    }
}
exports.RollbackFailedSafeError = RollbackFailedSafeError;
let StagedActivationService = StagedActivationService_1 = class StagedActivationService {
    config;
    logger = new common_1.Logger(StagedActivationService_1.name);
    constructor(config) {
        this.config = config;
    }
    slotCfg() {
        const { deployRoot, activeDirname } = this.config.releaseDeploy;
        return { deployRoot, activeDirname };
    }
    activePath() {
        return (0, release_slots_1.activeSlotPath)(this.slotCfg());
    }
    candidatePath(releaseId) {
        return (0, release_slots_1.slotPath)(this.slotCfg(), 'candidate', releaseId);
    }
    async buildCandidate(releaseId, manifest, stagingDir) {
        const candidate = this.candidatePath(releaseId);
        await (0, promises_1.rm)(candidate, { recursive: true, force: true });
        await (0, promises_1.mkdir)((0, path_1.dirname)(candidate), { recursive: true });
        await (0, promises_1.cp)(this.activePath(), candidate, { recursive: true, dereference: false, preserveTimestamps: true, force: true });
        for (const file of manifest.files) {
            const dest = (0, path_1.join)(candidate, file.path);
            if (file.action === 'delete') {
                await (0, promises_1.rm)(dest, { force: true });
                continue;
            }
            const src = (0, path_1.join)(stagingDir, file.path);
            await (0, promises_1.mkdir)((0, path_1.dirname)(dest), { recursive: true });
            await (0, promises_1.cp)(src, dest, { force: true });
        }
        for (const rootFile of ['package.json', 'package-lock.json']) {
            const src = (0, path_1.join)(stagingDir, rootFile);
            if (await exists(src)) {
                await (0, promises_1.cp)(src, (0, path_1.join)(candidate, rootFile), { force: true });
            }
        }
        await this.stampVersion(candidate, manifest.version);
        for (const dir of [(0, path_1.join)(candidate, '..', 'frontend'), (0, path_1.join)(candidate, 'frontend'), (0, path_1.join)(candidate, 'public')]) {
            await this.stampVersion(dir, manifest.version, true);
        }
        this.logger.log(`CANDIDATE built for release ${releaseId}: ${candidate} (${manifest.files.length} delta file(s))`);
        return candidate;
    }
    async stampVersion(dir, version, quietIfMissing = false) {
        const pkgPath = (0, path_1.join)(dir, 'package.json');
        let raw;
        try {
            raw = await (0, promises_1.readFile)(pkgPath, 'utf8');
        }
        catch {
            if (quietIfMissing)
                return;
            this.logger.warn(`FU-1: no package.json at ${pkgPath} to stamp — skipped`);
            return;
        }
        try {
            const pkg = JSON.parse(raw);
            if (pkg.version === version)
                return;
            const prev = pkg.version;
            pkg.version = version;
            await (0, promises_1.writeFile)(pkgPath, JSON.stringify(pkg, null, 2) + (raw.endsWith('\n') ? '\n' : ''), 'utf8');
            this.logger.log(`FU-1: stamped ${pkgPath} version ${prev ?? '(none)'} → ${version}`);
        }
        catch (e) {
            this.logger.warn(`FU-1: could not stamp ${pkgPath}: ${e.message}`);
        }
    }
    async verifyCandidate(candidatePath) {
        const checks = [];
        const add = (name, ok, detail) => checks.push({ name, status: ok ? 'pass' : 'fail', detail });
        const nodeBin = this.config.releaseBuild.nodeBin;
        const mainJs = (0, path_1.join)(candidatePath, 'dist', 'main.js');
        const pkgJson = (0, path_1.join)(candidatePath, 'package.json');
        add('structure', (await exists(mainJs)) && (await exists(pkgJson)), `${mainJs} + ${pkgJson}`);
        const distDir = (0, path_1.join)(candidatePath, 'dist');
        let jsFiles = [];
        try {
            jsFiles = await listJsFiles(distDir);
        }
        catch {
        }
        let bad = 0;
        for (const f of jsFiles) {
            try {
                await execFileAsync(nodeBin, ['--check', f], { timeout: 15_000 });
            }
            catch {
                bad++;
            }
        }
        add('dist_syntax', bad === 0, `${jsFiles.length} dist .js checked, ${bad} bad`);
        const publicDir = (0, path_1.join)(candidatePath, 'public');
        const indexHtml = (0, path_1.join)(publicDir, 'index.html');
        if (await exists(indexHtml)) {
            const html = await (0, promises_1.readFile)(indexHtml, 'utf8');
            const refs = new Set();
            let m;
            BUNDLE_REF_RE.lastIndex = 0;
            while ((m = BUNDLE_REF_RE.exec(html)) !== null) {
                const withoutQuery = m[1].split(/[?#]/)[0];
                const relToPublic = withoutQuery.replace(/^\//, '').replace(/^public\//, '');
                refs.add(relToPublic);
            }
            const missing = [];
            for (const r of refs) {
                if (!(await exists((0, path_1.join)(publicDir, r))))
                    missing.push(r);
            }
            add('frontend_bundle', missing.length === 0, missing.length === 0 ? `${refs.size} asset ref(s) resolve` : `missing: ${missing.join(', ')}`);
        }
        else {
            add('frontend_bundle', true, 'no public/index.html (backend-only tree)');
        }
        try {
            await execFileAsync(nodeBin, ['-e', "require.resolve('@nestjs/core')"], { cwd: candidatePath, timeout: 15_000 });
            add('node_modules_symlink', true, "require.resolve('@nestjs/core') from the candidate tree");
        }
        catch (err) {
            add('node_modules_symlink', false, `require.resolve('@nestjs/core') failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        const depCheck = await (0, dependency_check_1.checkDependenciesResolve)(candidatePath, nodeBin);
        add('dependencies_resolve', depCheck.ok, depCheck.detail);
        const ok = checks.every((c) => c.status === 'pass');
        return { ok, checks };
    }
    async activeIsIntact() {
        return (await exists((0, path_1.join)(this.activePath(), 'dist', 'main.js'))) && (await exists((0, path_1.join)(this.activePath(), 'package.json')));
    }
    async activate(releaseId, candidatePath) {
        const [toPrev, toActive] = (0, release_slots_1.atomicSwapRenames)(this.slotCfg(), releaseId, candidatePath);
        await (0, promises_1.rename)(toPrev.from, toPrev.to);
        try {
            await (0, promises_1.rename)(toActive.from, toActive.to);
        }
        catch (err) {
            await (0, promises_1.rename)(toPrev.to, toPrev.from).catch(() => undefined);
            throw new Error(`ATOMIC SWAP failed on CANDIDATE→ACTIVE: ${err instanceof Error ? err.message : String(err)}`);
        }
        this.logger.log(`ATOMIC SWAP done for ${releaseId}: PREVIOUS=${toPrev.to}, ACTIVE=${this.activePath()}`);
        return { previousPath: toPrev.to, activePath: this.activePath() };
    }
    async rollbackSwap(releaseId) {
        const [toFailed, toActive] = (0, release_slots_1.rollbackRenames)(this.slotCfg(), releaseId);
        try {
            await (0, promises_1.rename)(toFailed.from, toFailed.to);
        }
        catch (err) {
            throw new RollbackFailedSafeError(`reverse rename ACTIVE→FAILED failed: ${err instanceof Error ? err.message : String(err)}`, 'active_to_failed');
        }
        try {
            await (0, promises_1.rename)(toActive.from, toActive.to);
        }
        catch (err) {
            throw new RollbackFailedSafeError(`reverse rename PREVIOUS→ACTIVE failed after ACTIVE was moved to FAILED — the app root is now MISSING: ${err instanceof Error ? err.message : String(err)}`, 'previous_to_active');
        }
        this.logger.warn(`ROLLBACK swap done for ${releaseId}: FAILED=${toFailed.to}, ACTIVE restored from PREVIOUS`);
        return { failedPath: toFailed.to, activePath: this.activePath() };
    }
    async pruneSlots(keepReleaseIds = []) {
        const { slotRetention } = this.config.releaseDeploy;
        const cfg = this.slotCfg();
        const slotDir = (0, path_1.dirname)(this.activePath());
        let entries;
        try {
            entries = await (0, promises_1.readdir)(slotDir);
        }
        catch {
            return { pruned: [] };
        }
        const byKind = { previous: [], failed: [] };
        for (const name of entries) {
            const abs = (0, path_1.join)(slotDir, name);
            const c = (0, release_slots_1.classifySlotName)(cfg, abs);
            if (!c || c.kind === 'candidate')
                continue;
            let mtime = 0;
            try {
                mtime = (await (0, promises_1.stat)(abs)).mtimeMs;
            }
            catch {
                continue;
            }
            byKind[c.kind].push({ path: abs, releaseId: c.releaseId, mtime });
        }
        const pruned = [];
        for (const kind of ['previous', 'failed']) {
            const kept = byKind[kind].filter((s) => keepReleaseIds.includes(s.releaseId));
            const rest = byKind[kind].filter((s) => !keepReleaseIds.includes(s.releaseId)).sort((a, b) => b.mtime - a.mtime);
            for (const stale of rest.slice(Math.max(0, slotRetention - kept.length))) {
                await (0, promises_1.rm)(stale.path, { recursive: true, force: true });
                pruned.push((0, path_1.relative)(slotDir, stale.path));
            }
        }
        if (pruned.length)
            this.logger.log(`Pruned ${pruned.length} old slot(s): ${pruned.join(', ')}`);
        return { pruned };
    }
};
exports.StagedActivationService = StagedActivationService;
exports.StagedActivationService = StagedActivationService = StagedActivationService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [app_config_service_1.AppConfigService])
], StagedActivationService);
async function exists(p) {
    try {
        await (0, promises_1.access)(p, fs_1.constants.F_OK);
        return true;
    }
    catch {
        return false;
    }
}
async function listJsFiles(dir) {
    const out = [];
    const walk = async (d) => {
        const ents = await (0, promises_1.readdir)(d, { withFileTypes: true });
        for (const e of ents) {
            const p = (0, path_1.join)(d, e.name);
            if (e.isDirectory())
                await walk(p);
            else if (e.isFile() && e.name.endsWith('.js'))
                out.push(p);
        }
    };
    await walk(dir);
    return out;
}
//# sourceMappingURL=staged-activation.service.js.map