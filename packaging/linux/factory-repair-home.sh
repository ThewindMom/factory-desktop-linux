#!/bin/sh
# factory-repair-home — ensure ~/.factory exists and is usable by the user.
#
# Two callers:
#   1. factory-desktop.postinst (root, per logged-in user) creates/repairs
#      ~/.factory and ~/.factory/automations with correct ownership at
#      install time.
#   2. factory-droid-daemon.service ExecStartPre (as the user) detects a
#      foreign-owned ~/.factory — the signature of an install that ran as
#      root — and exits with the exact fix instead of letting the daemon
#      crash-loop on:
#        EACCES: permission denied, mkdir '<home>/.factory/auth.v2.write.<hash>.pending'
#
# Usage:
#   factory-repair-home [--create-automations]             # current user
#   factory-repair-home [--create-automations] USER HOME   # root, target user
#
# IMPORTANT: keep this file free of dollar-brace variable syntax; fpm
# expands dollar-brace macros in maintainer scripts (see postinst header).
# $var and $(cmd) are fine.

set -eu

CREATE_AUTOMATIONS=0

while [ $# -gt 0 ]; do
    case "$1" in
        --create-automations) CREATE_AUTOMATIONS=1; shift ;;
        --) shift; break ;;
        -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        -*) echo "factory-repair-home: unknown option: $1" >&2; exit 2 ;;
        *) break ;;
    esac
done

if [ "$(id -u)" = "0" ]; then
    IS_ROOT=1
else
    IS_ROOT=0
fi

if [ $# -ge 1 ]; then
    if [ "$IS_ROOT" = "0" ]; then
        echo "factory-repair-home: only root may target another user" >&2
        exit 2
    fi
    TARGET_USER=$1
    TARGET_HOME=$2
else
    TARGET_USER=$(id -un)
    TARGET_HOME=$HOME
fi

print_fix() {
    echo "factory-repair-home: $1 is not writable by user '$2' (foreign owner or restrictive mode)." >&2
    echo "  An installer running as root likely created or took over this directory." >&2
    echo "  The daemon then dies on sign-in with:" >&2
    echo "    EACCES: permission denied, mkdir '<home>/.factory/auth.v2.write.<hash>.pending'" >&2
    echo "  Fix:   sudo chown -R $2:$2 $1" >&2
    echo "  Then:  systemctl --user restart factory-droid-daemon.service" >&2
}

if [ ! -d "$TARGET_HOME" ]; then
    echo "factory-repair-home: home directory $TARGET_HOME does not exist" >&2
    exit 1
fi

TARGET_UID=$(id -u "$TARGET_USER" 2>/dev/null) || {
    echo "factory-repair-home: no such user: $TARGET_USER" >&2
    exit 1
}
GROUP=$(id -gn "$TARGET_USER" 2>/dev/null || echo "$TARGET_UID")

FACTORY_DIR=$TARGET_HOME/.factory

if [ -d "$FACTORY_DIR" ]; then
    if [ "$IS_ROOT" = "1" ]; then
        OWNER=$(stat -c %u "$FACTORY_DIR" 2>/dev/null || echo unknown)
        if [ "$OWNER" != "$TARGET_UID" ]; then
            chown -R "$TARGET_UID:$GROUP" "$FACTORY_DIR" 2>/dev/null || true
            OWNER=$(stat -c %u "$FACTORY_DIR" 2>/dev/null || echo unknown)
            if [ "$OWNER" != "$TARGET_UID" ]; then
                print_fix "$FACTORY_DIR" "$TARGET_USER"
                exit 1
            fi
            echo "factory-repair-home: repaired ownership of $FACTORY_DIR for $TARGET_USER"
        fi
    else
        # Non-root: verify we can actually write into ~/.factory — that is
        # exactly what the daemon needs. A root-owned (or mode-locked)
        # directory is what triggers the EACCES crash-loop on sign-in.
        PROBE=$FACTORY_DIR/.repair-probe-$$
        if ! mkdir "$PROBE" 2>/dev/null; then
            print_fix "$FACTORY_DIR" "$TARGET_USER"
            exit 1
        fi
        rmdir "$PROBE" 2>/dev/null || true
    fi
else
    # Create each level explicitly; the chown below keeps root ownership
    # from ever happening in the first place.
    mkdir -p "$FACTORY_DIR" 2>/dev/null || true
    if [ ! -d "$FACTORY_DIR" ]; then
        echo "factory-repair-home: cannot create $FACTORY_DIR" >&2
        exit 1
    fi
    if [ "$IS_ROOT" = "1" ]; then
        chown "$TARGET_UID:$GROUP" "$FACTORY_DIR"
    fi
fi

if [ "$CREATE_AUTOMATIONS" = "1" ]; then
    AUTOMATIONS_DIR=$FACTORY_DIR/automations
    if [ ! -d "$AUTOMATIONS_DIR" ]; then
        # Best-effort only: a missing automations dir is a warning in the
        # app, so it must not block daemon startup.
        if ! mkdir "$AUTOMATIONS_DIR" 2>/dev/null; then
            echo "factory-repair-home: warning: cannot create $AUTOMATIONS_DIR" >&2
        fi
    fi
    if [ "$IS_ROOT" = "1" ] && [ -d "$AUTOMATIONS_DIR" ]; then
        chown "$TARGET_UID:$GROUP" "$AUTOMATIONS_DIR" 2>/dev/null || true
    fi
fi

exit 0
