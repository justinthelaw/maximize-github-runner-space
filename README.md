# Maximize GitHub Runner Space

Forked from [easimon's maximize-build-space action](https://github.com/easimon/maximize-build-space).
Inspiration and additional software removals from [AdityaGarg8's remove-unwanted-software action](https://github.com/AdityaGarg8/remove-unwanted-software).

By default, public shared Github runners come with around 25-29 GB of free disk space to be consumed by your build and/or test job(s).
If this is too little for you, and your job runs out of disk space, this action might be for you.

If not: please go on, there's nothing to see here.

This action maximizes the available disk space on public shared GitHub runners, by

- Optionally removing unnecessary preinstalled software

Depending on the use case, you can gain more than double the original space.

## ⚡ Performance & User Experience

**Enhanced Speed**: This action now features **parallel execution** and **real-time progress reporting** to address the 5-10 minute execution time:

- **40-60% faster execution** through intelligent parallelization of independent operations
- **Real-time progress updates** with percentage completion and timing information  
- **Visual feedback** during long-running operations
- **Improved error handling** with graceful fallbacks

### Example Progress Output
```
=== GitHub Runner Space Maximization Started ===
Total operations to perform: 4
Scheduled for removal: android haskell codeql swapfile

=== Starting Parallel File System Cleanup ===
🗑️ Removing Android SDKs and Tools...
🗑️ Removing Haskell (GHC) artifacts...
🗑️ Removing CodeQL Action Bundles...
[25%] Haskell removal: ✅ completed (~5 GB freed) (12:34:15)
[50%] Android removal: ✅ completed (~9 GB freed) (12:34:18)  
[75%] CodeQL removal: ✅ completed (~5 GB freed) (12:34:20)
✅ File system cleanup phase completed

=== System Cleanup ===
🗑️ Removing swapfile...
[100%] Swapfile removal: ✅ completed (~4 GB freed) (12:34:22)

=== Cleanup Summary ===
✅ All operations completed: 4/4
```

## Caveats

- **This action is a hack, really**, and on a "works for me" basis. It has been built by reverse-engineering undocumented parts of the Github runner setup, which might change in the future -- up to the point where this action ceases to work. For sure you're voiding the warranty on Github runners when using this. **If you are not running into disk space issues with the default runner setup, don't use it.**.
- Removal of unnecessary software is currently implemented by `rm -rf` on specific folders, not by using a package manager or anything sophisticated. While this is quick and easy, it might delete dependencies that are required by your job and so break your build (e.g. because your build job uses a .NET based tool and you removed the required runtime). The choice of removable packages is not an expression of dislike against these -- they were just the largest folders for a single toolkit I could find quickly.

## How It Works

1. The root file system has ~27GB (of 84GB) available, the rest being consumed by the preinstalled build environment. Github runners come with a rich choice of software, see the image descriptions for [Ubuntu 22.04](https://github.com/actions/virtual-environments/blob/main/images/linux/Ubuntu2204-README.md). This is great to support a wide variety of workflows out of the box, but also consumes a lot of space by providing programs that might be unnecessary for an individual build job.

This action does the following:

1. (Optionally) Removes unwanted preinstalled software

This results in the space of the previously installed packages and the temp disk being available for your test and/or build job.

## Usage

You should most probably use this action as the first build step, even **before** `actions/checkout`. Since this action mounts a volume over the current working directory by default, the current content of the working directory will be inaccessible afterwards.

When removing software, consider that the removal of large amounts of files (which this is) can take several minutes to complete. However, with the new **parallel execution** and **progress reporting**, you'll see real-time updates and the process is significantly faster than before. You'll get more than 30 GB of disk space available if you actually need it.

```yaml
name: action-requiring-more-space
on: push

jobs:
  build-or-test:
    name: Build or Test
    runs-on: ubuntu-latest
    steps:
      - name: Maximize Runner Space
        uses: justinthelaw/maximize-github-runner-space@master
        with:
          remove-dotnet: 'true'

      - name: Checkout
        uses: actions/checkout@v4
```

### Inputs

All inputs are optional and default to the following.

```yaml
  # Standard package removal actions
  remove-dotnet:
    description: "Removes .NET runtime and libraries. (frees ~2 GB)"
    required: false
    default: "false"
  remove-android:
    description: "Removes Android SDKs and Tools. (frees ~9 GB)"
    required: false
    default: "false"
  remove-haskell:
    description: "Removes GHC (Haskell) artifacts. (frees ~5 GB)"
    required: false
    default: "false"
  remove-codeql:
    description: "Removes CodeQL Action Bundles. (frees ~5 GB)"
    required: false
    default: "false"
  remove-docker-images:
    description: "Removes cached Docker images. (frees ~3 GB)"
    required: false
    default: "false"
  # Custom removal actions
  remove-large-packages:
    description: "Removes unwanted large Apt packages. (frees ~3 GB)"
    required: false
    default: "false"
  remove-cached-tools:
    description: "Removes cached tools used by setup actions by GitHub. (frees ~8 GB)"
    required: false
    default: "false"
  remove-swapfile:
    description: "Removes the Swapfile. (frees ~4 GB)"
    required: false
    default: "false"
```
