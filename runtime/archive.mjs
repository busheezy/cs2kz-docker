import { createWriteStream, mkdirSync, chmodSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import * as tar from "tar";
import yauzl from "yauzl";

export function safePath(root, relative) {
  if (
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    relative.split("/").includes("..") ||
    relative.includes("\0")
  ) {
    throw new Error("Unsafe archive or manifest path");
  }
  const destination = path.resolve(root, relative);
  const canonicalRoot = realpathSync(root);
  let current = destination;
  while (current !== path.dirname(current)) {
    try {
      const resolved = realpathSync(current);
      if (resolved !== canonicalRoot && !resolved.startsWith(canonicalRoot + path.sep)) {
        throw new Error("Path escapes installation");
      }
      break;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      try {
        if (lstatSync(current).isSymbolicLink()) {
          throw new Error("Dangling symlink in installation path");
        }
      } catch (statError) {
        if (statError.code !== "ENOENT") {
          throw statError;
        }
      }
      current = path.dirname(current);
    }
  }
  return destination;
}

export async function unpack(archive, target, zipFormat) {
  if (!zipFormat) {
    let invalid;
    await tar.x({
      file: archive,
      cwd: target,
      strict: true,
      preserveOwner: false,
      filter(name, entry) {
        try {
          safePath(target, name);
          if (!["File", "Directory"].includes(entry.type)) {
            throw new Error("Archive links and special files are not allowed");
          }
          return true;
        } catch (error) {
          invalid = error;
          return false;
        }
      },
    });
    if (invalid) {
      throw invalid;
    }
    return;
  }
  const zip = await promisify(yauzl.open)(archive, { lazyEntries: true });
  await new Promise((resolve, reject) => {
    zip.once("error", reject);
    zip.once("end", resolve);
    zip.on("entry", (entry) => {
      extractZipEntry(zip, entry, target)
        .then(() => zip.readEntry())
        .catch((error) => {
          zip.close();
          reject(error);
        });
    });
    zip.readEntry();
  });
}

async function extractZipEntry(zip, entry, target) {
  const mode = entry.externalFileAttributes >>> 16;
  const type = mode & 0o170000;
  if (type && ![0o100000, 0o040000].includes(type)) {
    throw new Error("Archive links and special files are not allowed");
  }
  const destination = safePath(target, entry.fileName);
  if (entry.fileName.endsWith("/")) {
    mkdirSync(destination, { recursive: true });
    return;
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  const input = await promisify(zip.openReadStream.bind(zip))(entry);
  await pipeline(input, createWriteStream(destination));
  chmodSync(destination, mode & 0o111 ? 0o755 : 0o644);
}
