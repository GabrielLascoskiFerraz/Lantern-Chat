#include <libgen.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/utsname.h>
#include <unistd.h>

int main(int argc, char **argv) {
  char executable_path[4096];
  uint32_t size = sizeof(executable_path);
  if (_NSGetExecutablePath(executable_path, &size) != 0) {
    fprintf(stderr, "Lantern Relay: caminho do aplicativo excede o limite.\n");
    return 1;
  }

  char resolved_path[4096];
  if (realpath(executable_path, resolved_path) == NULL) {
    perror("Lantern Relay: não foi possível resolver o caminho do aplicativo");
    return 1;
  }

  char directory_copy[4096];
  strncpy(directory_copy, resolved_path, sizeof(directory_copy) - 1);
  directory_copy[sizeof(directory_copy) - 1] = '\0';
  const char *macos_directory = dirname(directory_copy);

  struct utsname system_info;
  if (uname(&system_info) != 0) {
    perror("Lantern Relay: não foi possível identificar a arquitetura");
    return 1;
  }

  const char *runtime_name = strcmp(system_info.machine, "arm64") == 0
    ? "LanternRelay-arm64"
    : "LanternRelay-x64";
  char runtime_path[4096];
  snprintf(runtime_path, sizeof(runtime_path), "%s/../Resources/runtime/%s", macos_directory, runtime_name);

  /* When invoked from an existing terminal, keep the process in that terminal. */
  if (isatty(STDIN_FILENO) || isatty(STDOUT_FILENO) || isatty(STDERR_FILENO)) {
    argv[0] = runtime_path;
    execv(runtime_path, argv);
    perror("Lantern Relay: não foi possível iniciar o runtime Node");
    return 1;
  }

  /* Finder does not provide a terminal. Open one explicitly so logs and errors
     remain visible to the operator while the Node server is running. */
  execl(
    "/usr/bin/osascript",
    "osascript",
    "-e", "on run argv",
    "-e", "tell application \"Terminal\"",
    "-e", "activate",
    "-e", "do script \"exec \" & quoted form of (item 1 of argv)",
    "-e", "end tell",
    "-e", "end run",
    "--",
    runtime_path,
    (char *)NULL
  );
  perror("Lantern Relay: não foi possível abrir o Terminal");
  return 1;
}
