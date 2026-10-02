import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import os from 'os'
import path from 'path'
import {
  MAX_SSH_HOST_KEYS,
  hostKeyPathsInSshdConfig,
  readSshHostKeyFingerprints,
  sshFingerprintOfPublicKeyLine
} from './ssh-host-keys'

// GitHub publishes its SSH host keys together with the fingerprints OpenSSH prints for them
// (docs.github.com, "GitHub's SSH key fingerprints"): an outside vector for the exact format, which is
// also the one sshj reports on the phone (`SshHostConnection.fingerprint`, checked against the same
// keys in the protocol tests).
const GITHUB_ED25519 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'
const GITHUB_ED25519_FP = 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU'
const GITHUB_ECDSA =
  'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg='
const GITHUB_ECDSA_FP = 'SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM'

/** A fresh ed25519 public key line, as `ssh-keygen` writes a `.pub`. */
function ed25519Line(comment = 'root@host'): string {
  const name = Buffer.from('ssh-ed25519', 'ascii')
  const len = (n: number): Buffer => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n, 0)
    return b
  }
  return `ssh-ed25519 ${Buffer.concat([len(name.length), name, len(32), randomBytes(32)]).toString('base64')} ${comment}`
}

const dirs: string[] = []
const tempDir = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'nt-ssh-host-keys-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('sshFingerprintOfPublicKeyLine', () => {
  it('prints what OpenSSH prints: SHA256 of the key blob, unpadded base64', () => {
    expect(sshFingerprintOfPublicKeyLine(`${GITHUB_ED25519} root@github\n`)).toBe(GITHUB_ED25519_FP)
    expect(sshFingerprintOfPublicKeyLine(GITHUB_ECDSA)).toBe(GITHUB_ECDSA_FP)
    // A comment line and a blank line before the key, and CRLF, change nothing.
    expect(sshFingerprintOfPublicKeyLine(`# host key\r\n\r\n${GITHUB_ED25519}\r\n`)).toBe(GITHUB_ED25519_FP)
  })

  it('refuses what is not a plain public key', () => {
    const [, blob] = GITHUB_ED25519.split(' ')
    // The line says one type and the blob another: it is not the key it claims to be.
    expect(sshFingerprintOfPublicKeyLine(`ssh-rsa ${blob}`)).toBeNull()
    expect(sshFingerprintOfPublicKeyLine(`ssh-ed25519-cert-v01@openssh.com ${blob}`)).toBeNull()
    expect(sshFingerprintOfPublicKeyLine('ssh-ed25519 not*base64')).toBeNull()
    expect(sshFingerprintOfPublicKeyLine('ssh-ed25519')).toBeNull()
    expect(sshFingerprintOfPublicKeyLine('ssh-ed25519 AAAA')).toBeNull()
    expect(sshFingerprintOfPublicKeyLine('')).toBeNull()
  })
})

describe('hostKeyPathsInSshdConfig', () => {
  it('reads every absolute HostKey, in both keyword forms and quoted', () => {
    const text = [
      '# HostKey /etc/ssh/commented_out',
      'HostKey /etc/ssh/ssh_host_ed25519_key',
      '  hostkey=/opt/keys/a_key',
      'HOSTKEY "/opt/keys/with space_key"',
      'HostKey relative_key',
      'HostKey /home/%u/token_key',
      'HostKeyAlgorithms ssh-ed25519',
      'Port 22'
    ].join('\n')
    expect(hostKeyPathsInSshdConfig(text)).toEqual([
      '/etc/ssh/ssh_host_ed25519_key',
      '/opt/keys/a_key',
      '/opt/keys/with space_key'
    ])
  })
})

describe('readSshHostKeyFingerprints', () => {
  it('reads every ssh_host_*_key.pub in the directories, and nothing else there', async () => {
    const etcSsh = tempDir()
    const etc = tempDir()
    writeFileSync(path.join(etcSsh, 'ssh_host_ed25519_key.pub'), `${GITHUB_ED25519} root@box\n`)
    writeFileSync(path.join(etcSsh, 'ssh_host_ecdsa_key.pub'), `${GITHUB_ECDSA} root@box\n`)
    // A certificate, a private key, a user key and a key under another name are not host public keys.
    writeFileSync(path.join(etcSsh, 'ssh_host_ed25519_key-cert.pub'), `${ed25519Line()}\n`)
    writeFileSync(path.join(etcSsh, 'ssh_host_ed25519_key'), '-----BEGIN OPENSSH PRIVATE KEY-----\n')
    writeFileSync(path.join(etcSsh, 'id_ed25519.pub'), `${ed25519Line()}\n`)
    // The old macOS place (/etc), the same key again: listed once.
    writeFileSync(path.join(etc, 'ssh_host_ed25519_key.pub'), `${GITHUB_ED25519} root@old-mac\n`)
    expect(await readSshHostKeyFingerprints([etcSsh, etc])).toEqual([GITHUB_ECDSA_FP, GITHUB_ED25519_FP])
  })

  it('adds the keys sshd_config and its drop-ins name elsewhere', async () => {
    const etcSsh = tempDir()
    const keys = tempDir()
    const own = ed25519Line()
    const agentHeld = ed25519Line()
    writeFileSync(path.join(keys, 'custom_key.pub'), `${own}\n`)
    writeFileSync(path.join(keys, 'agent_key.pub'), `${agentHeld}\n`)
    writeFileSync(path.join(etcSsh, 'sshd_config'), `HostKey ${path.join(keys, 'custom_key')}\n`)
    mkdirSync(path.join(etcSsh, 'sshd_config.d'))
    // A public key named directly (sshd takes one when the private key is held by an agent).
    writeFileSync(path.join(etcSsh, 'sshd_config.d', '10-agent.conf'), `HostKey ${path.join(keys, 'agent_key.pub')}\n`)
    writeFileSync(path.join(etcSsh, 'sshd_config.d', 'ignored.txt'), `HostKey ${path.join(keys, 'nope')}\n`)
    expect(await readSshHostKeyFingerprints([etcSsh])).toEqual([
      sshFingerprintOfPublicKeyLine(own),
      sshFingerprintOfPublicKeyLine(agentHeld)
    ])
  })

  it('leaves out what cannot be read, and gives an empty list when nothing can', async () => {
    const etcSsh = tempDir()
    // Not a regular file, too large to be a key, and not a key at all.
    mkdirSync(path.join(etcSsh, 'ssh_host_dir_key.pub'))
    writeFileSync(path.join(etcSsh, 'ssh_host_big_key.pub'), `${GITHUB_ED25519} ${'x'.repeat(20_000)}\n`)
    writeFileSync(path.join(etcSsh, 'ssh_host_junk_key.pub'), 'not a key\n')
    writeFileSync(path.join(etcSsh, 'sshd_config'), 'HostKey /nonexistent/nt-test/missing_key\n')
    expect(await readSshHostKeyFingerprints([etcSsh, path.join(etcSsh, 'no-such-dir')])).toEqual([])
    // …and a readable key beside them is still read.
    writeFileSync(path.join(etcSsh, 'ssh_host_ok_key.pub'), `${GITHUB_ED25519}\n`)
    expect(await readSshHostKeyFingerprints([etcSsh])).toEqual([GITHUB_ED25519_FP])
  })

  it('stops at the cap', async () => {
    const etcSsh = tempDir()
    for (let i = 0; i < MAX_SSH_HOST_KEYS + 4; i++) {
      writeFileSync(path.join(etcSsh, `ssh_host_k${String(i).padStart(2, '0')}_key.pub`), `${ed25519Line()}\n`)
    }
    expect(await readSshHostKeyFingerprints([etcSsh])).toHaveLength(MAX_SSH_HOST_KEYS)
  })
})
