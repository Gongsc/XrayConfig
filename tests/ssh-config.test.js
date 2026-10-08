"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const script = path.resolve(__dirname, "../scripts/configure-ssh-keys.sh");
const requiredSettings = new Map([
  ["passwordauthentication", "no"],
  ["pubkeyauthentication", "yes"],
  ["kbdinteractiveauthentication", "no"],
  ["challengeresponseauthentication", "no"],
  ["authenticationmethods", "publickey"],
]);

function write(file, contents, mode = 0o640) {
  fs.writeFileSync(file, contents, { mode });
}

function fixture(t, directoryPrefix = "ssh-config-test-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), directoryPrefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, "sshd_config");
  const dropins = `${config}.d`;
  const bin = path.join(dir, "bin");
  fs.mkdirSync(dropins);
  fs.mkdirSync(bin);
  const serviceLog = path.join(dir, "service-calls");
  const sshdLog = path.join(dir, "sshd-calls");
  const sshdCount = path.join(dir, "sshd-count");
  write(path.join(bin, "id"), "#!/bin/sh\n[ \"$1\" = -u ] || exit 98\nprintf '0\\n'\n", 0o755);
  for (const command of ["service", "systemctl"]) {
    write(path.join(bin, command), `#!/bin/sh\nprintf '%s\\n' '${command}' >> "$TEST_SERVICE_LOG"\nexit 99\n`, 0o755);
  }
  const sshd = path.join(bin, "sshd");
  write(sshd, `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_SSHD_LOG"
[ "$2" = -f ] && [ "$3" = "$TEST_CONFIG" ] && [ "$#" = 3 ] || exit 97
case "$1" in
  -t)
    count=0
    [ ! -f "$TEST_SSHD_COUNT" ] || count=$(cat "$TEST_SSHD_COUNT")
    count=$((count + 1))
    printf '%s\\n' "$count" > "$TEST_SSHD_COUNT"
    if [ "$count" = "$TEST_FAIL_VALIDATION_AT" ]; then
      printf 'fixture validation failure\\n' >&2
      exit 1
    fi
    ;;
  -T)
    [ -n "$TEST_EFFECTIVE_PASSWORD" ] || TEST_EFFECTIVE_PASSWORD=no
    printf 'passwordauthentication %s\\n' "$TEST_EFFECTIVE_PASSWORD"
    printf 'pubkeyauthentication yes\\nkbdinteractiveauthentication no\\nauthenticationmethods publickey\\n'
    ;;
  *) exit 96 ;;
esac
`, 0o755);
  const base = path.join(dropins, "10-base.conf");
  const match = path.join(dropins, "90-match.conf");
  const untouched = path.join(dropins, "50-unrelated.conf");
  const ignored = path.join(dropins, "README");
  write(config, `# Keep the administrator's comments.
Port 2244
UsePAM yes
PermitRootLogin prohibit-password
AuthorizedKeysFile .ssh/authorized_keys .ssh/keys
PasswordAuthentication=yes # disable this override
PUBKEYAUTHENTICATION no
KbdInteractiveAuthentication yes
ChallengeResponseAuthentication yes
AuthenticationMethods publickey,password
Include "${dropins}/*.conf"
Match User root
    PasswordAuthentication yes
    PubkeyAuthentication no
    ChallengeResponseAuthentication yes # historical alias
    AuthenticationMethods password publickey,password
    AllowTcpForwarding no
`);
  write(base, `# Cloud image defaults.
passwordauthentication yes
PubkeyAuthentication=no
KbdInteractiveAuthentication yes
ChallengeResponseAuthentication=yes
AuthenticationMethods any
LoginGraceTime 45
`, 0o600);
  write(match, `Match Address 192.0.2.0/24
\tPasswordAuthentication yes # local network
\tPubkeyAuthentication no
\tKbdInteractiveAuthentication yes
\tChallengeResponseAuthentication yes
\tAuthenticationMethods keyboard-interactive
\tX11Forwarding no
`, 0o644);
  write(untouched, "# These settings do not need changing.\nMaxAuthTries 3\n", 0o600);
  write(ignored, "PasswordAuthentication yes\n", 0o644);
  const files = [config, base, match, untouched, ignored];
  const original = snapshot(files);
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH || "/usr/bin:/bin"}`,
    SSHD_BIN: sshd,
    TEST_CONFIG: config,
    TEST_SERVICE_LOG: serviceLog,
    TEST_SSHD_LOG: sshdLog,
    TEST_SSHD_COUNT: sshdCount,
  };
  return {
    dir, config, dropins, files, original, sshdLog, serviceLog,
    run(args = [], extraEnv = {}) {
      const result = spawnSync("bash", [script, "--config", config, ...args], {
        env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 10000,
      });
      assert.ifError(result.error);
      assert.equal(fs.existsSync(serviceLog), false, "must never invoke service or systemctl");
      return result;
    },
    backups() {
      return fs.readdirSync(dir).filter((name) => name.startsWith(".ssh-key-auth-backup-"))
        .map((name) => path.join(dir, name));
    },
  };
}

function snapshot(files) {
  return new Map(files.map((file) => {
    const stat = fs.statSync(file);
    return [file, { contents: fs.readFileSync(file, "utf8"), mode: stat.mode & 0o777,
      uid: stat.uid, gid: stat.gid, inode: stat.ino }];
  }));
}

function assertUnchanged(original) {
  for (const [file, before] of original) {
    assert.deepEqual(snapshot([file]).get(file), before, file);
  }
}

function assertSuccess(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function assertPolicy(contents) {
  let count = 0;
  for (const line of contents.split("\n")) {
    const directive = line.trim().match(/^([^\s=]+)[\s=]+([^#]*?)(?:\s*#.*)?$/);
    if (!directive) continue;
    const keyword = directive[1].toLowerCase();
    if (!requiredSettings.has(keyword)) continue;
    assert.equal(directive[2].trim(), requiredSettings.get(keyword), line);
    count++;
  }
  assert.ok(count >= 5, "fixture should exercise every authentication directive");
}

function assertBackups(f) {
  const backups = f.backups();
  assert.equal(backups.length, 1);
  const entries = fs.readFileSync(path.join(backups[0], "manifest.tsv"), "utf8")
    .trim().split("\n").map((line) => line.split("\t"));
  assert.deepEqual(new Set(entries.map(([, file]) => file)), new Set(f.files.slice(0, 3)));
  for (const [index, file] of entries) {
    const backup = path.join(backups[0], index);
    const before = f.original.get(file);
    assert.equal(fs.readFileSync(backup, "utf8"), before.contents);
    assert.equal(fs.statSync(backup).mode & 0o777, before.mode);
  }
}

test("SSH script changes main, drop-in and Match authentication settings while preserving other configuration", (t) => {
  const f = fixture(t);
  const result = f.run();
  assertSuccess(result);
  for (const file of f.files.slice(0, 3)) {
    assertPolicy(fs.readFileSync(file, "utf8"));
    const after = snapshot([file]).get(file);
    const before = f.original.get(file);
    for (const key of ["mode", "uid", "gid", "inode"]) assert.equal(after[key], before[key], `${file}: ${key}`);
  }
  const main = fs.readFileSync(f.config, "utf8");
  assert.ok(main.startsWith("# Managed by configure-ssh-keys.sh\nPasswordAuthentication no\n"));
  for (const unchanged of ["# Keep the administrator's comments.", "Port 2244", "UsePAM yes",
    "PermitRootLogin prohibit-password", "AuthorizedKeysFile .ssh/authorized_keys .ssh/keys",
    `Include "${f.dropins}/*.conf"`, "Match User root", "    AllowTcpForwarding no"])
    assert.ok(main.includes(`${unchanged}\n`), unchanged);
  assert.ok(main.includes("PasswordAuthentication no # disable this override\n"));
  assert.ok(main.includes("    ChallengeResponseAuthentication no # historical alias\n"));
  const match = fs.readFileSync(f.files[2], "utf8");
  assert.ok(match.includes("Match Address 192.0.2.0/24\n"));
  assert.ok(match.includes("\tPasswordAuthentication no # local network\n"));
  assert.ok(match.includes("\tX11Forwarding no\n"));
  assertUnchanged(new Map(f.files.slice(3).map((file) => [file, f.original.get(file)])));
  assertBackups(f);
  assert.deepEqual(fs.readFileSync(f.sshdLog, "utf8").trim().split("\n"),
    [`-t -f ${f.config}`, `-t -f ${f.config}`, `-T -f ${f.config}`]);
  assert.match(result.stdout, /not restarted or reloaded/);
});

test("SSH script is idempotent and creates no additional backup on a second run", (t) => {
  const f = fixture(t);
  assertSuccess(f.run());
  const after = snapshot(f.files);
  const backups = f.backups();
  assertSuccess(f.run());
  assertUnchanged(after);
  assert.deepEqual(f.backups(), backups);
  assert.equal(fs.readFileSync(f.config, "utf8").match(/# Managed by configure-ssh-keys\.sh/g).length, 1);
});

test("SSH dry run reports diffs without modifying files, creating backups or calling sshd", (t) => {
  const f = fixture(t);
  const result = f.run(["--dry-run"], { SSHD_BIN: path.join(f.dir, "missing-sshd") });
  assertSuccess(result);
  assertUnchanged(f.original);
  assert.deepEqual(f.backups(), []);
  assert.equal(fs.existsSync(f.sshdLog), false);
  assert.match(result.stdout, /Planned changes:/);
  assert.match(result.stdout, /\+PasswordAuthentication no/);
  assert.match(result.stdout, /Dry run completed/);
});

test("SSH script refuses an invalid existing configuration before writing", (t) => {
  const f = fixture(t);
  const result = f.run([], { TEST_FAIL_VALIDATION_AT: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Existing SSH configuration failed validation/);
  assertUnchanged(f.original);
  assert.deepEqual(f.backups(), []);
});

test("SSH script restores every changed file when updated configuration validation fails", (t) => {
  const f = fixture(t);
  const result = f.run([], { TEST_FAIL_VALIDATION_AT: "2" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Updated SSH configuration failed validation/);
  assert.match(result.stderr, /Restoring SSH configuration/);
  assertUnchanged(f.original);
  assertBackups(f);
});

test("SSH script rolls back when effective settings still permit password authentication", (t) => {
  const f = fixture(t);
  const result = f.run([], { TEST_EFFECTIVE_PASSWORD: "yes" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Effective SSH setting differs from: passwordauthentication no/);
  assertUnchanged(f.original);
  assertBackups(f);
});

test("SSH script refuses Include files outside the selected main and drop-in directory", (t) => {
  const f = fixture(t);
  const external = path.join(f.dir, "external.conf");
  write(external, "PasswordAuthentication yes\n");
  fs.appendFileSync(f.files[1], `Include "${external}"\n`);
  const before = snapshot([...f.files, external]);
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Include outside sshd_config/);
  assertUnchanged(before);
  assert.deepEqual(f.backups(), []);
  assert.equal(fs.existsSync(f.sshdLog), false);
});

test("SSH script refuses quoted or escaped keywords and unsupported Include path spellings before writing", async (t) => {
  const backslash = String.fromCharCode(92);
  const cases = [
    ["single-quoted authentication keyword in Match", () => "Match User tester\n    'PasswordAuthentication' yes\n"],
    ["escaped authentication keyword in Match", () => `Match User tester\n    Passw${backslash}ordAuthentication yes\n`],
    ["double-quoted Include keyword", (external) => `"Include" "${external}"\n`],
    ["single-quoted Include path", (external) => `Include '${external}'\n`],
    ["escaped space in Include path", (external) => `Include ${external.replace(/ /g, `${backslash} `)}\n`],
  ];
  for (const [name, directive] of cases) {
    await t.test(name, (t) => {
      const f = fixture(t);
      const external = path.join(f.dir, "external config.conf");
      write(external, "PasswordAuthentication yes\n");
      fs.appendFileSync(f.files[2], directive(external));
      const before = snapshot([...f.files, external]);
      const result = f.run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Unsupported quoted\/escaped keyword or Include path/);
      assertUnchanged(before);
      assert.deepEqual(f.backups(), []);
      assert.equal(fs.existsSync(f.sshdLog), false, "reject before validation or writing");
    });
  }
});

test("SSH script accepts a conventional double-quoted Include with spaces in its directory path", (t) => {
  const f = fixture(t, "ssh config test ");
  assertSuccess(f.run());
  assert.ok(fs.readFileSync(f.config, "utf8").includes(`Include "${f.dropins}/*.conf"\n`));
  for (const file of f.files.slice(0, 3)) assertPolicy(fs.readFileSync(file, "utf8"));
  assertBackups(f);
});

test("real sshd parser confirms public-key-only authentication in global and Match contexts", (t) => {
  const sshd = "/usr/sbin/sshd";
  const keygen = "/usr/bin/ssh-keygen";
  if (!fs.existsSync(sshd) || !fs.existsSync(keygen)) {
    t.skip("OpenSSH sshd and ssh-keygen are unavailable");
    return;
  }
  const f = fixture(t);
  const hostKey = path.join(f.dir, "host_ed25519");
  const keyResult = spawnSync(keygen, ["-q", "-t", "ed25519", "-N", "", "-f", hostKey], { encoding: "utf8", timeout: 10000 });
  assert.ifError(keyResult.error);
  assertSuccess(keyResult);
  // Keep a fully valid, isolated configuration for the real parser; no daemon is started.
  write(f.config, `HostKey ${hostKey}\nUsePAM no\nPasswordAuthentication yes\nPubkeyAuthentication no\nInclude ${f.dropins}/*.conf\nMatch User root\n    PasswordAuthentication yes\n    PubkeyAuthentication no\n    AuthenticationMethods password\n`);
  write(f.files[1], "ChallengeResponseAuthentication yes\nAuthenticationMethods any\n");
  write(f.files[2], "Match Address 192.0.2.0/24\n    PasswordAuthentication yes\n    PubkeyAuthentication no\n    KbdInteractiveAuthentication yes\n    AuthenticationMethods keyboard-interactive\n");
  const probe = spawnSync(sshd, ["-T", "-f", f.config], { encoding: "utf8", timeout: 10000 });
  assert.ifError(probe.error);
  if (probe.status !== 0 && /Privilege separation user|Missing privilege separation directory|Operation not permitted|Permission denied/i.test(probe.stderr)) {
    t.skip(`OpenSSH parser unavailable in this environment: ${probe.stderr.trim()}`);
    return;
  }
  assertSuccess(probe);
  const result = f.run([], { SSHD_BIN: sshd });
  assertSuccess(result);
  for (const context of [null, "user=root,host=example.test,addr=198.51.100.10",
    "user=tester,host=example.test,addr=192.0.2.7", "user=root,host=example.test,addr=192.0.2.7"]) {
    const args = ["-T", "-f", f.config];
    if (context) args.push("-C", context);
    const parsed = spawnSync(sshd, args, { encoding: "utf8", timeout: 10000 });
    assert.ifError(parsed.error);
    assertSuccess(parsed);
    const settings = new Map(parsed.stdout.trim().split("\n").map((line) => {
      const space = line.indexOf(" ");
      return [line.slice(0, space), line.slice(space + 1)];
    }));
    for (const [keyword, value] of requiredSettings) {
      if (keyword === "challengeresponseauthentication") continue; // sshd reports its canonical alias.
      assert.equal(settings.get(keyword), value, `${context || "global"}: ${keyword}`);
    }
  }
});
