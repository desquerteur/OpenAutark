// Owns: static NSIS uninstaller reconstruction and the original NSIS CRC check.
// Never: executes the input or output, changes trust, or rewrites an invalid CRC.
// Extracted unchanged from electron-builder (MIT), PR #10262, commit
// 3f63861d8d5eb5cb277a5ee95149c7686d848705. See electron-builder.LICENSE.
// Only unrelated classes/imports were omitted. Requires Node >=22.15 for zlib.crc32.
import * as fs from 'node:fs/promises';
import * as zlib from 'node:zlib';

class BinaryReader {
  private readonly _buffer: Buffer
  private _position: number

  constructor(buffer: Buffer) {
    this._buffer = buffer
    this._position = 0
  }

  get length(): number {
    return this._buffer.length
  }

  get position(): number {
    return this._position
  }

  match(signature: Array<number>): boolean {
    if (signature.every((v, i) => this._buffer[this._position + i] === v)) {
      this._position += signature.length
      return true
    }
    return false
  }

  skip(offset: number) {
    this._position += offset
  }

  bytes(size: number): Buffer {
    const value = this._buffer.subarray(this._position, this._position + size)
    this._position += size
    return value
  }

  uint16(): number {
    const value = this._buffer[this._position] | (this._buffer[this._position + 1] << 8)
    this._position += 2
    return value
  }

  uint32(): number {
    return this.uint16() | (this.uint16() << 16)
  }

  string(length: number): string {
    let value = ""
    for (let i = 0; i < length; i++) {
      const c = this._buffer[this._position + i]
      if (c === 0x00) {
        break
      }
      value += String.fromCharCode(c)
    }
    this._position += length
    return value
  }
}

export class UninstallerReader {
  // noinspection SpellCheckingInspection
  static async exec(installerPath: string, uninstallerPath: string) {
    const buffer = await fs.readFile(installerPath)
    const reader = new BinaryReader(buffer)
    // IMAGE_DOS_HEADER
    if (!reader.match([0x4d, 0x5a])) {
      throw new Error("Invalid 'MZ' signature.")
    }
    reader.skip(58)
    // e_lfanew
    reader.skip(reader.uint32() - reader.position)
    // IMAGE_FILE_HEADER
    if (!reader.match([0x50, 0x45, 0x00, 0x00])) {
      throw new Error("Invalid 'PE' signature.")
    }
    reader.skip(2)
    const numberOfSections = reader.uint16()
    reader.skip(12)
    const sizeOfOptionalHeader = reader.uint16()
    reader.skip(2)
    reader.skip(sizeOfOptionalHeader)
    // IMAGE_SECTION_HEADER
    let nsisOffset = 0
    for (let i = 0; i < numberOfSections; i++) {
      const name = reader.string(8)
      reader.skip(8)
      const rawSize = reader.uint32()
      const rawPointer = reader.uint32()
      reader.skip(16)
      switch (name) {
        case ".text":
        case ".rdata":
        case ".data":
        case ".rsrc": {
          nsisOffset = Math.max(rawPointer + rawSize, nsisOffset)
          break
        }
        default: {
          if (rawPointer !== 0 && rawSize !== 0) {
            throw new Error("Unsupported section '" + name + "'.")
          }
          break
        }
      }
    }
    // copied, because the uninstaller icon is patched into it below
    const executable = Buffer.from(buffer.subarray(0, nsisOffset))
    const nsisSize = buffer.length - nsisOffset
    const nsisReader = new BinaryReader(buffer.subarray(nsisOffset, nsisOffset + nsisSize))
    if (!isNsisFirstHeader(buffer, nsisOffset)) {
      throw new Error("Invalid signature.")
    }
    nsisReader.skip(NSIS_FIRST_HEADER_SIZE - 4)
    if (nsisSize !== nsisReader.uint32()) {
      throw new Error("Size mismatch.")
    }

    // The data block is a sequence of [size | compressed flag][data] entries (non-solid compression only).
    // makensis stores the uninstaller icon patch and then the uninstaller data as two consecutive entries (build.cpp uninstall_generate)
    let iconData: Buffer | null = null
    let innerBuffer: Buffer | null = null
    let previousBlock: Buffer | null = null
    while (true) {
      let size = nsisReader.uint32()
      const compressed = (size & 0x80000000) !== 0
      size = size & 0x7fffffff
      if (size === 0 || nsisReader.position + size > nsisReader.length || nsisReader.position >= nsisReader.length) {
        break
      }
      let block = nsisReader.bytes(size)
      if (compressed) {
        block = zlib.inflateRawSync(block)
      }
      if (isNsisFirstHeader(block, 0) && (block.readUInt32LE(0) & FH_FLAGS_UNINSTALL) !== 0) {
        if (innerBuffer) {
          throw new Error("Multiple inner blocks.")
        }
        innerBuffer = block
        iconData = previousBlock
      }
      previousBlock = block
    }
    if (!innerBuffer || !iconData) {
      throw new Error("Inner block not found.")
    }
    applyUninstallerIconData(executable, iconData)

    const uninstaller = Buffer.concat([executable, innerBuffer])
    verifyNsisIntegrity(uninstaller)
    await fs.writeFile(uninstallerPath, uninstaller)
  }
}

const NSIS_FIRST_HEADER_SIZE = 28
// siginfo (0xDEADBEEF) followed by "NullsoftInst"; the preceding 4 bytes of the firstheader are its flags
const NSIS_SIGNATURE = Buffer.from([0xef, 0xbe, 0xad, 0xde, 0x4e, 0x75, 0x6c, 0x6c, 0x73, 0x6f, 0x66, 0x74, 0x49, 0x6e, 0x73, 0x74])
const FH_FLAGS_MASK = 15
const FH_FLAGS_UNINSTALL = 1
const FH_FLAGS_NO_CRC = 4
const FH_FLAGS_FORCE_CRC = 8

function isNsisFirstHeader(data: Buffer, offset: number): boolean {
  return (
    offset + NSIS_FIRST_HEADER_SIZE <= data.length &&
    (data.readUInt32LE(offset) & ~FH_FLAGS_MASK) === 0 &&
    data.subarray(offset + 4, offset + 4 + NSIS_SIGNATURE.length).equals(NSIS_SIGNATURE)
  )
}

// WriteUninstaller (exehead/exec.c) patches the uninstaller icon into a copy of the installer's exehead before writing it out,
// and makensis computes the uninstaller CRC over that patched exehead. The icon data is a list of [size][offset][bytes] records.
function applyUninstallerIconData(executable: Buffer, iconData: Buffer) {
  let position = 0
  // exec.c stops at the first zero byte (not a zero dword), so mirror that exactly
  while (position < iconData.length && iconData[position] !== 0) {
    if (position + 8 > iconData.length) {
      throw new Error("Truncated uninstaller icon data.")
    }
    const size = iconData.readUInt32LE(position)
    const offset = iconData.readUInt32LE(position + 4)
    position += 8
    if (position + size > iconData.length || offset + size > executable.length) {
      throw new Error("Invalid uninstaller icon data.")
    }
    iconData.copy(executable, offset, position, position + size)
    position += size
  }
  if (position >= iconData.length) {
    throw new Error("Uninstaller icon data is not terminated.")
  }
}

/**
 * Performs the same integrity check that the NSIS exehead runs on startup (loadHeaders in exehead/fileform.c),
 * so a broken uninstaller fails the build instead of showing "Installer integrity check has failed" to the end user.
 */
export function verifyNsisIntegrity(data: Buffer): void {
  // the exehead looks for the firstheader at 512-byte boundaries
  for (let offset = 0; offset < data.length; offset += 512) {
    if (!isNsisFirstHeader(data, offset)) {
      continue
    }
    const flags = data.readUInt32LE(offset)
    if ((flags & FH_FLAGS_FORCE_CRC) === 0 && (flags & FH_FLAGS_NO_CRC) !== 0) {
      return
    }
    const lengthOfAllFollowingData = data.readUInt32LE(offset + 24)
    if (lengthOfAllFollowingData < NSIS_FIRST_HEADER_SIZE + 4 || lengthOfAllFollowingData > data.length - offset) {
      throw new Error("NSIS integrity check failed: data length mismatch.")
    }
    // the first 512 bytes are not covered, the CRC itself is stored right after the checked data
    const crcOffset = offset + lengthOfAllFollowingData - 4
    const actual = zlib.crc32(data.subarray(offset === 0 ? 0 : 512, crcOffset))
    const expected = data.readUInt32LE(crcOffset)
    if (actual !== expected) {
      throw new Error(`NSIS integrity check failed: CRC32 is 0x${actual.toString(16)}, expected 0x${expected.toString(16)}.`)
    }
    return
  }
  throw new Error("NSIS integrity check failed: NSIS header not found.")
}
