# Public cloud checks

The fresh public source is checked on a standard GitHub Linux runner: API and
web unit tests, production builds and a checksum-verified secret scan. Private
SQLite WAL/SHM files, the packaged APK and old history are retained in the
verified private recovery archive.

The first real cloud run failed because the unprivileged runner could not create
the application's `/data/uploads` directory. The workflow now prepares an empty,
runner-owned `/data` directory to reproduce the container's writable data volume.
This also allows the mocked ffmpeg tests to write their synthetic output frames.
Production code, test expectations and production data are unchanged.

After preparing the volume, 65 of 66 API files passed. The remaining three
assertions exposed a Linux-specific test-double error: production wraps ffmpeg
with `nice -n 19`, while the fake recognized only a bare `ffmpeg` command and
reported success without writing frames. The fake now unwraps that launcher.
The existing cover-generation and graceful-failure assertions are retained.
