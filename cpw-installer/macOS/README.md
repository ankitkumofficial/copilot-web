# macOS `cpw` installer

Run the installer from a copilot-web checkout:

```shell
bash cpw-installer/macOS/install.sh
```

It requires macOS, Node.js 24 or newer, npm, and the GitHub Copilot CLI on
`PATH`. It builds the app, installs the `cpw` command in `~/.local/bin`, and
creates a per-user LaunchAgent at
`~/Library/LaunchAgents/com.github.copilot-web.plist`. If needed, it adds
`~/.local/bin` to the current shell user's startup file (`~/.zshrc` for zsh or
`~/.bash_profile` for bash). It does not start the service during installation.

Open a new terminal after installation if the installer updated your shell
startup file, then use:

```shell
cpw start
cpw status
cpw restart
cpw stop
```

`status`, `start`, and `restart` report the listener's host and port. The
LaunchAgent logs are written to `~/Library/Logs/copilot-web/`. Complete
`copilot login` before using the app.

If the checkout is moved, run the installer again from its new location, then
run `cpw restart` to load the updated LaunchAgent configuration.

To uninstall the command and LaunchAgent, run:

```shell
bash cpw-installer/macOS/uninstall.sh
```

The uninstaller removes the PATH block added by the installer when it can
identify the current shell's startup file. It leaves the copilot-web checkout
and service logs untouched.
