const { join, resolve } = require('path');
const fs = require('fs').promises;
const readline = require('readline');

const fetch = require('node-fetch');
const download = require('download-package-tarball');
const glob = require('glob').sync;
const chalk = require('chalk');

/**
 * Ask the user a question via console and wait for the response
 *
 * @param {String} question The question to ask the user.
 * @returns {Promise<String>} The response the user gives.
 */
const input = question => new Promise(resolve => {
    const readlineInterface = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    readlineInterface.question(question, resp => {
        resolve(resp);
        readlineInterface.close();
    });
});

/**
 * Allows the user to explore the directories and files within the given path
 * Asks for a directory inout and lists files in that directory
 * Will recurse until a blank input is given by the user
 *
 * @param {String} path The base path to explore from
 * @returns {Promise<void>}
 */
const explore = async path => {
    const pathInput = await input(chalk.magenta.italic('Path to explore in package (blank to end): '));
    if (pathInput) {
        // List files
        try {
            const files = await fs.readdir(join(path, pathInput));
            console.log(files.join('\t'));
        } catch (e) {
            console.error(chalk.red(e.message));
        }

        // Recurse
        await explore(path);
    }
};

/**
 * Allows the user to test basePath and globPattern combinations within the given path
 * Will recurse until a blank input is given by the user
 *
 * @param {String} path The base path to explore from
 * @returns {Promise<void>}
 */
const globExplore = async path => {
    const globInput = await input(chalk.magenta.italic('Glob to test in package [<basePath> <globPattern>] (blank to end): '));
    if (globInput) {
        // List files
        try {
            const [basePath, globPattern] = globInput.split(' ', 2);
            const files = glob(globPattern, { cwd: join(path, basePath), nodir: true });
            console.log(files.join('\t'));
        } catch (e) {
            console.error(chalk.red(e.message));
        }

        // Recurse
        await globExplore(path);
    }
};

/**
 * @typedef {Object} fileMapItem
 * @property {String} basePath The initial path that all file patterns in this map start from
 * @property {Array<String>} files The list of file patterns to search for (globs)
 */

/**
 * @typedef {Array<fileMapItem>} fileMap
 */

/**
 * Generates an array of all files that a given fileMap will match in the given path
 *
 * @param {String} path The base path to run the fileMap in
 * @param {fileMap} fileMap The list of file map items to run
 * @returns {Array<string>} All file paths matched by the fileMap in the path
 */
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
    const [, , rawName] = process.argv;

    // Validate
    if (!rawName) {
        console.error(chalk.red('Usage: node index.js <cdnjsLibraryName>'));
        return;
    }

    // Build the base package
    const cdnjsData = {};
    cdnjsData.name = rawName;

    // Get the NPM package name to use
    const npmName = (await input(chalk.cyan.bold(`NPM package name (blank for ${rawName}): `))).trim() || rawName;

    // Get the package from NPM
    const rawData = await fetch(`https://registry.npmjs.com/${npmName}`);
    const jsonData = await rawData.json();

    // Error if NPM errored
    if (jsonData.error) {
        console.error(chalk.red(jsonData.error));
        return;
    }

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
        console.error(chalk.red(jsonVersionData.error));
        return;
    }

    // Ack
    console.log(`Located ${jsonData.name}@${jsonData['dist-tags'].latest}...`);

    // Download tarball
    const tarPath = join(__dirname, 'temp', jsonData.name, jsonData['dist-tags'].latest);
    await download({
        url: jsonVersionData.dist.tarball,
        dir: tarPath,
    });

    // Ack
    console.log(`Downloaded ${jsonData.name}@${jsonData['dist-tags'].latest}...\n`);

    // Allow the user to explore
    await explore(join(tarPath, jsonData.name));

    // Allow the user to test globs
    await globExplore(join(tarPath, jsonData.name));

    // Get final auto-update
    const fileMap = [];
    console.log(chalk.cyan.bold('\nFile map(s) to use for auto-updating library...'));
    while (true) {
        const basePath = await input(chalk.cyan.bold('Base path to use in file map (blank to end): '));

        // If no input, exit if safe
        if (!basePath) {
            if (!fileMap.length) {
                console.error(chalk.red('At least one file map is required for a library to auto-update'));
            } else {
                break;
            }
        } else {
            // Get globs for this path
            const patterns = [];
            while (true) {
                const globInput = await input(chalk.cyan.bold(`Glob pattern to get from base path ${basePath} (blank to end): `));

                // If no input, exit if safe
                if (!globInput) {
                    if (!patterns.length) {
                        console.error(chalk.red('At least one glob pattern is required for a base path in the file map'));
                    } else {
                        break;
                    }
                } else {
                    // Store
                    patterns.push(globInput);
                }
            }

            // Store
            fileMap.push({
                basePath: resolve(basePath) === resolve(__dirname) ? '' : basePath,
                files: patterns,
            });
        }
    }

    // Store the auto-update config
    cdnjsData.npmName = jsonData.name;
    cdnjsData.npmFileMap = fileMap;

    // Get the default filename
    const allFiles = allFileMapFiles(join(tarPath, jsonData.name), fileMap);
    console.log(`\nFiles matching file map in ${jsonData['dist-tags'].latest}:\n${allFiles.join('\t')}`);
    const filename = await input(chalk.cyan.bold(`Default file to highlight for usage (blank to skip): `));
    if (filename) {
        cdnjsData.filename = filename;
    }

    // Done
    console.log(chalk.green.bold(`\n\nCreate new file on cdnjs/cdnjs: ajax/libs/${cdnjsData.name}/package.json`));
    console.log(chalk.green(`${JSON.stringify(cdnjsData, null, 2)}`));
};

main();
