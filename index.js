const fetch = require('node-fetch');
const download = require('download-package-tarball');
const { join, resolve } = require('path');
const fs = require('fs').promises;
const readline = require('readline');
const glob = require('glob').sync;

const input = question => new Promise(resolve => {
    const readlineInterface = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    readlineInterface.question(question, resp => {
        resolve(resp);
        readlineInterface.close();
    });
});

const explore = async path => {
    const pathInput = await input('\nPath to explore in package (blank to end): ');
    if (pathInput) {
        // List files
        try {
            const files = await fs.readdir(join(path, pathInput));
            console.log(files.join('\t'));
        } catch (e) {
            console.error(e.message);
        }

        // Recurse
        await explore(path);
    }
};

const doGlobExplore = (globInput, path) => {
    const [basePath, globPattern] = globInput.split(' ', 2);
    return glob(globPattern, { cwd: join(path, basePath), nodir: true }).join('\t');
};

const globExplore = async path => {
    const globInput = await input('\nGlob to test in package [<basePath> <globPattern>] (blank to end): ');
    if (globInput) {
        // List files
        try {
            console.log(doGlobExplore(globInput, path));
        } catch (e) {
            console.error(e.message);
        }

        // Recurse
        await globExplore(path);
    }
};

const allFileMapFiles = (path, fileMap) => {
    const files = [];
    for (const map of fileMap) {
        for (const file of map.files) {
            try {
                files.push(...glob(file, { cwd: join(path, map.basePath), nodir: true }));
            } catch (_) {
            }
        }
    }
    return files;
};

const main = async () => {
    const [,,rawName] = process.argv;

    // Get the package from NPM
    const rawData = await fetch(`https://registry.npmjs.com/${rawName}`);
    const jsonData = await rawData.json();

    // Error if NPM errored
    if (jsonData.error) {
        console.error(jsonData.error);
        return;
    }

    // Build the base package
    const cdnjsData = {};
    cdnjsData.name = jsonData.name;
    cdnjsData.description = jsonData.description || '';
    cdnjsData.keywords = jsonData.keywords || [];
    cdnjsData.author = jsonData.author || '';
    cdnjsData.license = jsonData.license || '';
    cdnjsData.homepage = jsonData.homepage || '';
    cdnjsData.repository = jsonData.repository || {};

    // Get the latest version from NPM
    const rawVersionData = await fetch(`https://registry.npmjs.com/${jsonData.name}/${jsonData['dist-tags'].latest}`);
    const jsonVersionData = await rawVersionData.json();

    // Error if NPM errored
    if (jsonVersionData.error) {
        console.error(jsonVersionData.error);
        return;
    }

    // Ack
    console.log(`Located ${jsonData.name}@${jsonData['dist-tags'].latest}...`);

    // Get the name to use in cdnjs (might not match package name)
    cdnjsData.name = (await input(`\nName to use for library (blank for ${jsonData.name}): `)).trim() || jsonData.name;

    // Download tarball
    const tarPath = join(__dirname, 'temp', jsonData.name, jsonData['dist-tags'].latest);
    await download({
        url: jsonVersionData.dist.tarball,
        dir: tarPath,
    });

    // Ack
    console.log(`\nDownloaded ${jsonData.name}@${jsonData['dist-tags'].latest}...`);

    // Allow the user to explore
    await explore(join(tarPath, jsonData.name));

    // Allow the user to test globs
    await globExplore(join(tarPath, jsonData.name));

    // Get final auto-update
    const fileMap = [];
    console.log('\nFile map(s) to use for auto-updating library...');
    while (true) {
        const basePath = await input('\nBase path to use in file map (blank to end): ');

        // If no input, exit if safe
        if (!basePath) {
            if (!fileMap.length) {
                console.error('At least one file map is required for a library to auto-update');
            } else {
                break;
            }
        }

        // Get globs for this path
        const patterns = [];
        while (true) {
            const globInput = await input(`\nGlob pattern to get from base path ${basePath} (blank to end): `);

            // If no input, exit if safe
            if (!globInput) {
                if (!patterns.length) {
                    console.error('At least one glob pattern is required for a base path in the file map');
                } else {
                    break;
                }
            }

            // Store
            patterns.push(globInput);
        }

        // Store
        fileMap.push({
            basePath: resolve(basePath) === resolve(__dirname) ? '' : basePath,
            files: patterns,
        });
    }

    // Store the auto-update config
    cdnjsData.npmName = jsonData.name;
    cdnjsData.npmFileMap = fileMap;

    // Get the default filename
    const allFiles = allFileMapFiles(join(tarPath, jsonData.name), fileMap);
    console.log(`\nFiles from file map:\n${allFiles.join('\t')}`);
    const filename = await input(`\nDefault file to highlight for usage (blank to skip): `);
    if (filename) {
        cdnjsData.filename = filename;
    }

    // Done
    console.log(`\n\nCreate new file on cdnjs/cdnjs: ajax/libs/${cdnjsData.name}/package.json`);
    console.log(`${JSON.stringify(cdnjsData, null, 2)}`);
};

main();
