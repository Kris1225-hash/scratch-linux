// /init for the scratch pc: mount the pseudo filesystems, grab the serial console, keep a shell alive.
// written against plain syscalls so boot costs as few emulated instructions as possible.
#include <fcntl.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/reboot.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

static void say(const char *s) { write(1, s, strlen(s)); }

static void cat(const char *path) {
  char buf[512];
  int fd = open(path, O_RDONLY), n;
  if (fd < 0) return;
  while ((n = read(fd, buf, sizeof buf)) > 0) write(1, buf, n);
  close(fd);
}

int main(void) {
  mount("proc", "/proc", "proc", 0, 0);
  mount("sysfs", "/sys", "sysfs", 0, 0);
  mount("devtmpfs", "/dev", "devtmpfs", 0, 0);
  mount("tmpfs", "/tmp", "tmpfs", 0, 0);
  sethostname("scratch", 7);

  for (;;) {
    pid_t pid = fork();
    if (pid == 0) {
      setsid();
      int fd = open("/dev/ttyS0", O_RDWR);
      if (fd < 0) fd = open("/dev/console", O_RDWR);
      ioctl(fd, TIOCSCTTY, 1);
      dup2(fd, 0); dup2(fd, 1); dup2(fd, 2);
      if (fd > 2) close(fd);
      cat("/etc/motd");
      char *envp[] = { "HOME=/root", "PATH=/bin:/sbin:/usr/bin:/usr/sbin", "TERM=dumb", "USER=root", "SHELL=/bin/sh", "ENV=/etc/shrc", 0 };
      chdir("/root");
      char *argv[] = { "sh", 0 };
      execve("/bin/sh", argv, envp);
      say("init: cannot exec /bin/sh\n");
      _exit(127);
    }
    int st;
    while (wait(&st) != pid) { }
    say("\n[init] shell exited, starting a new one\n");
  }
}
