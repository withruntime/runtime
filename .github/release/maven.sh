#!/bin/sh
# The publish workflow's Maven Central step (publish.yml), at the public
# mirror's root: the Java SDK built with the JDK alone, each file signed and
# summed, the bundle uploaded to the Central Portal to publish once it
# validates, and its state followed until it is published or fails.
#
#   VERSION=0.2.0 sh .github/release/maven.sh
#
# The environment `release` gives CENTRAL_TOKEN_USER and CENTRAL_TOKEN_PASS
# (a Central Portal user token) and MAVEN_GPG_KEY (an armored private key
# whose public half is on keys.openpgp.org) with MAVEN_GPG_PASSPHRASE.
# DRY_RUN=1 builds and lists the bundle, and signs and uploads nothing.
set -eu

version=${VERSION:?VERSION is the version decide found}
java_home=${JAVA_HOME_17_X64:-${JAVA_HOME:-}}
bin=${java_home:+$java_home/bin/}
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
cd sdks/java

"${bin}javac" --release 17 -Xlint:all -Werror -d "$out/classes" $(find src/main/java -name '*.java')
dir="$out/bundle/com/withruntime/withruntime/$version"
mkdir -p "$dir"
base="$dir/withruntime-$version"
"${bin}jar" --create --file "$base.jar" -C "$out/classes" .
"${bin}jar" --create --file "$base-sources.jar" -C src/main/java .
"${bin}javadoc" -quiet --release 17 -Xdoclint:all,-missing -d "$out/javadoc" $(find src/main/java -name '*.java')
"${bin}jar" --create --file "$base-javadoc.jar" -C "$out/javadoc" .
cp pom.xml "$base.pom"

if [ -n "${DRY_RUN:-}" ]; then
  (cd "$out/bundle" && find . -type f | sort)
  echo "Dry run: nothing signed or uploaded."
  exit 0
fi

export GNUPGHOME="$out/gnupg"
mkdir -m 700 "$GNUPGHOME"
printf '%s\n' "$MAVEN_GPG_KEY" | gpg --batch --quiet --import
for file in "$base.jar" "$base-sources.jar" "$base-javadoc.jar" "$base.pom"; do
  printf '%s' "$MAVEN_GPG_PASSPHRASE" | gpg --batch --yes --pinentry-mode loopback \
    --passphrase-fd 0 --armor --detach-sign "$file"
  md5sum "$file" | cut -d' ' -f1 > "$file.md5"
  sha1sum "$file" | cut -d' ' -f1 > "$file.sha1"
done
(cd "$out/bundle" && zip -qr "$out/bundle.zip" .)

auth=$(printf '%s:%s' "$CENTRAL_TOKEN_USER" "$CENTRAL_TOKEN_PASS" | base64 -w0)
# The header goes in a file, never on a command line.
printf 'Authorization: Bearer %s\n' "$auth" > "$out/auth"
id=$(curl --fail-with-body --silent --show-error --request POST --header "@$out/auth" \
  --form "bundle=@$out/bundle.zip" \
  "https://central.sonatype.com/api/v1/publisher/upload?name=withruntime-$version&publishingType=AUTOMATIC")
echo "Uploaded com.withruntime:withruntime:$version as deployment $id."

# Validation and publishing take minutes; a failure says why.
i=0
while :; do
  status=$(curl --fail-with-body --silent --show-error --request POST --header "@$out/auth" \
    "https://central.sonatype.com/api/v1/publisher/status?id=$id")
  state=$(printf '%s' "$status" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).deploymentState))')
  case $state in
    PUBLISHED) echo "Published com.withruntime:withruntime:$version."; exit 0 ;;
    FAILED) echo "Maven Central refused it: $status" >&2; exit 1 ;;
  esac
  i=$((i + 1))
  [ "$i" -le 120 ] || { echo "Deployment $id is still $state after 40 minutes." >&2; exit 1; }
  sleep 20
done
