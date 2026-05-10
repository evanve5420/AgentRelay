import { existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, normalize, resolve } from "node:path";

export function createWorkContext(cwd = process.cwd()) {
    const normalizedCwd = normalize(resolve(String(cwd || process.cwd())));
    const repoRoot = findGitRoot(normalizedCwd);
    return {
        cwd: normalizedCwd,
        repoRoot,
        repoName: basename(repoRoot ?? normalizedCwd),
    };
}

export function findGitRoot(startPath) {
    let current = nearestExistingDirectory(startPath);
    while (true) {
        if (existsSync(resolve(current, ".git"))) return current;
        const parent = dirname(current);
        if (parent === current) return null;
        current = parent;
    }
}

export function isPathLike(value) {
    const text = String(value ?? "").trim();
    return isAbsolute(text) || text.startsWith(".") || /[\\/]/.test(text);
}

export function pathKey(value, baseCwd = process.cwd()) {
    if (!value) return null;
    const resolved = isAbsolute(String(value)) ? resolve(String(value)) : resolve(baseCwd, String(value));
    const normalized = normalize(resolved).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function nameKey(value) {
    const text = String(value ?? "").trim();
    return process.platform === "win32" ? text.toLowerCase() : text;
}

export function basenameKey(value) {
    if (!value) return null;
    return nameKey(basename(String(value)));
}

function nearestExistingDirectory(startPath) {
    let current = normalize(resolve(String(startPath || process.cwd())));
    while (true) {
        try {
            const stats = statSync(current);
            return stats.isDirectory() ? current : dirname(current);
        } catch {
            const parent = dirname(current);
            if (parent === current) return current;
            current = parent;
        }
    }
}
