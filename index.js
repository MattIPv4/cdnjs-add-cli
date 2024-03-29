const { join, resolve } = require('path');
const fs = require('fs').promises;
const readline = require('readline');

const fetch = require('node-fetch');
const download = require('download-tarball');
const glob = require('glob').sync;
const chalk = require('chalk');
const config = require('./config');
const { Octokit } = require('@octokit/rest');
const octokit = new (Octokit.plugin(require('octokit-create-pull-request')))({ auth: config.githubToken });
const gitUrlParse = require('git-url-parse');

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
            if (await fs.lstat(join(path, pathInput)).then(stat => stat.isFile())) {
                console.log(await fs.readFile(join(path, pathInput), 'utf8'));
            } else {
                const files = await fs.readdir(join(path, pathInput));
                console.log(files.join('\t'));
            }
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

/**
 * Creates an automatic PR for the cdnjs repo to add the new library
 *
 * @param {Object} data The library data for cdnjs
 * @param {String} [body = ''] Additional text to add to the PR body
 * @returns {Promise<Object>} The response from GitHub (PR or error)
 */
const createPR = async (data, body = '') => {
    const name = `Add ${data.name} w/ ${data.autoupdate.source} auto-update`;

    const files = {};
    files[`packages/${data.name.slice(0, 1).toLowerCase()}/${data.name}.json`] = `${JSON.stringify(data, null, 2)}\n`;

    return await octokit.createPullRequest({
        owner: config.targetRepoOwner,
        repo: config.targetRepoName,
        title: name,
        body: `Adding ${data.name} using ${data.autoupdate.source} auto-update from ${data.autoupdate.target}.${body.length ? '\n\n' : ''}${body}`,
        head: `${config.branchBase}${data.name}`,
        changes: {
            files,
            commit: name
        }
    });
};

/**
 * Allows the user to select either NPM or GitHub for auto-updating
 *
 * @returns {Promise<Number>} The selection made by the user (1: NPM, 2: GitHub)
 */
const updateChoice = async () => {
    while (true) {
        try {
            const choice = await input(chalk.cyan.bold('1) Auto-update via NPM package\n2) Auto-update via tagged GitHub repo\nAuto-update method to use (1 or 2): '));
            const cleaned = Number(choice.toString().trim());

            if ([1, 2].includes(cleaned)) {
                return cleaned;
            }

            console.error(chalk.red('Please select either \'1\' or \'2\' for auto-update.'));
        } catch (_) {
        }
    }
};

/**
 * Allows the user to first explore the library before providing the auto-update configuration.
 *
 * @param {String} path The base path to explore from
 * @returns {Promise<fileMap>} The auto-update fileMap provided by the user
 */
const exploreAndGlob = async path => {
    // Allow the user to explore
    await explore(path);

    // Allow the user to test globs
    await globExplore(path);

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

    return fileMap;
};

/**
 * List all files in the version given by the path that match the file map, let the user pick one or none
 *
 * @param {String} path The base path to run the fileMap in
 * @param {fileMap} fileMap The list of file map items to run
 * @param {String} version The version this path is for
 * @returns {Promise<String>} The file the user selected, or an empty string
 */
const chooseDefault = async (path, fileMap, version) => {
    const allFiles = allFileMapFiles(path, fileMap);
    console.log(`\nFiles matching file map in ${version}:\n${allFiles.join('\t')}`);
    return await input(chalk.cyan.bold(`Default file to highlight for usage (blank to skip): `));
};

/**
 * Get the first directory in a path
 *
 * @param {String} path The base path to find a directory in
 * @returns {Promise<String>} The first directory found
 */
const getFirstDirectory = async path =>
    (await fs.readdir(path, { withFileTypes: true }))
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name)[0];

/**
 * Transform a set of author strings/objects into consistent author objects
 *
 * @param {Array<String|Object>} authors The unclean authors
 * @return {{name: *, email: *, url: *}[]} The cleaned, consistent authors
 */
const transformAuthors = authors => authors.filter(x => !!x).map(author => {
    // Get the name, email & url
    let name = typeof author === 'string' ? author : author.name;
    const email = author.email || name.match(/^.*?((?: <.+>)?)(?: \(.+\))?$/)[1].slice(2).slice(0, -1);
    const url = author.url || author.homepage || name.match(/^.*?((?: \(.+\))?)(?: <.+>)?$/)[1].slice(2).slice(0, -1);
    name = name.match(/^(.*?)(?:(?: \(.+\))|(?: <.+>)){0,2}$/)[1];

    // Create the obj and clean
    const data = {
        name,
        email,
        url,
    };
    for (let key in data) {
        if (!data[key]) {
            delete data[key];
        }
    }
    return data;
});

/**
 * Generate the full cdnjsData for an NPM package
 *
 * @param {Object} cdnjsData The initial, bare-bones cdnjsData
 * @returns {Promise<Object>|Promise<void>} The fully-fledged cdnjsData for the NPM package
 */
const npm = async cdnjsData => {
    // Get the NPM package name to use
    const npmName = (await input(chalk.cyan.bold(`\nNPM package name (blank for ${cdnjsData.name}): `))).trim()
        || cdnjsData.name;

    // Get the package from NPM
    const rawData = await fetch(`https://registry.npmjs.com/${npmName}`);
    const jsonData = await rawData.json();

    // Error if NPM errored
    if (jsonData.error) {
        console.error(chalk.red(jsonData.error));
        return;
    }

    // Get the latest version from NPM
    const jsonVersionData = jsonData.versions[jsonData['dist-tags'].latest];

    // Ack
    console.log(`Located ${jsonData.name}@${jsonData['dist-tags'].latest}...`);

    // Merge in the version
    const jsonFullData = {
        ...jsonVersionData,
        ...jsonData
    };

    // Store basic info
    cdnjsData.description = jsonFullData.description || '';
    cdnjsData.keywords = jsonFullData.keywords || [];
    cdnjsData.license = jsonFullData.license || '';
    cdnjsData.homepage = jsonFullData.homepage || '';
    cdnjsData.repository = jsonFullData.repository || {};

    // Authors magic
    cdnjsData.authors = transformAuthors([jsonFullData.author, ...(Array.isArray(jsonFullData.authors) ? jsonFullData.authors : [jsonFullData.authors])]);

    // Download tarball
    const tarPath = join(__dirname, 'temp', jsonData.name, jsonData['dist-tags'].latest);
    await download({
        url: jsonVersionData.dist.tarball,
        dir: tarPath,
    }).catch(e => console.error(e.message, e.stack));
    const fullPath = join(tarPath, await getFirstDirectory(tarPath));

    // Ack
    console.log(`Downloaded ${jsonData.name}@${jsonData['dist-tags'].latest}...\n`);

    // Let the user explore and provide the auto-update config
    cdnjsData.autoupdate = {
        source: 'npm',
        target: jsonData.name,
        fileMap: await exploreAndGlob(fullPath),
    };

    // Get the default filename
    const defaultFile = await chooseDefault(fullPath, cdnjsData.autoupdate.fileMap, jsonData['dist-tags'].latest);
    if (defaultFile) {
        cdnjsData.filename = defaultFile;
    }

    // Cleanup
    await fs.rmdir(tarPath, { recursive: true });

    return cdnjsData;
};

/**
 * Prompts the user to provide a GitHub.com repository, will loop until they provide a valid repo
 *
 * @returns {Promise<[String, String]>} The owner and name of the repository on GitHub.com
 */
const githubRepo = async () => {
    while (true) {
        try {
            const repoInput = await input(chalk.cyan.bold('\nGitHub repository URL: '));
            const parsedRepo = gitUrlParse(repoInput);

            if (parsedRepo.source === 'github.com' && parsedRepo.owner && parsedRepo.name) {
                return [parsedRepo.owner, parsedRepo.name];
            }

            console.error(chalk.red('Could not parse a valid GitHub.com repo from given input.'));
        } catch (_) {
        }
    }
};

/**
 * Generate the full cdnjsData for a GitHub.com repository
 *
 * @param {Object} cdnjsData The initial, bare-bones cdnjsData
 * @returns {Promise<Object>|Promise<void>} The fully-fledged cdnjsData for the GitHub repository
 */
const github = async cdnjsData => {
    // Get the git repo name & owner
    const [repoOwner, repoName] = await githubRepo();

    // Get the tags from the repo
    const repoTags = await octokit.repos.listTags({
        owner: repoOwner,
        repo: repoName,
    });

    // Error if no tags found
    if (!repoTags.data || !repoTags.data.length) {
        console.error(chalk.red(`No tags found in repository https://github.com/${repoOwner}/${repoName}`));
        return;
    }

    // Get general repo data
    const repoData = await octokit.repos.get({
        owner: repoOwner,
        repo: repoName,
    });
    const repoTopics = await octokit.repos.getAllTopics({
        owner: repoOwner,
        repo: repoName,
    });

    // Store basic info
    cdnjsData.description = repoData && repoData.data && repoData.data.description;
    cdnjsData.keywords = repoTopics && repoTopics.data && repoTopics.data.names;
    cdnjsData.author = repoOwner;
    cdnjsData.license = repoData && repoData.data && repoData.data.license && repoData.data.license.spdx_id;
    cdnjsData.homepage = (repoData && repoData.data && repoData.data.homepage)
        || `https://github.com/${repoOwner}/${repoName}`;
    cdnjsData.repository = {
        type: 'git',
        url: `git://github.com/${repoOwner}/${repoName}.git`,
    };

    // Ack
    console.log(`Located ${repoOwner}/${repoName}@${repoTags.data[0].name}...`);

    // Download tarball
    const tarPath = join(__dirname, 'temp', repoOwner, repoName, repoTags.data[0].name);
    await download({
        url: repoTags.data[0].tarball_url,
        dir: tarPath,
    });
    const fullPath = join(tarPath, await getFirstDirectory(tarPath));

    // Ack
    console.log(`Downloaded ${repoOwner}/${repoName}@${repoTags.data[0].name}...\n`);

    // Use package.json data if we can
    let jsonFile;
    try {
        const rawFile = await fs.readFile(join(fullPath, 'package.json'));
        jsonFile = JSON.parse(rawFile.toString('utf8'));
    } catch (_) {
        try {
            const rawFile = await fs.readFile(join(fullPath, 'bower.json'));
            jsonFile = JSON.parse(rawFile.toString('utf8'));
        } catch (_) {
        }
    }

    if (jsonFile) {
        cdnjsData.description = jsonFile.description || cdnjsData.description;
        cdnjsData.keywords = jsonFile.keywords || cdnjsData.keywords;
        cdnjsData.author = jsonFile.author || cdnjsData.author;
        cdnjsData.license = jsonFile.license || cdnjsData.license;
        cdnjsData.homepage = jsonFile.homepage || cdnjsData.homepage;
    }

    // Authors magic
    cdnjsData.authors = transformAuthors([cdnjsData.author, ...((jsonFile && jsonFile.authors) || [])]);
    delete cdnjsData.author;

    // Let the user explore and provide the auto-update config
    cdnjsData.autoupdate = {
        source: 'git',
        target: `git://github.com/${repoOwner}/${repoName}.git`,
        fileMap: await exploreAndGlob(fullPath),
    };

    // Get the default filename
    const defaultFile = await chooseDefault(fullPath, cdnjsData.autoupdate.fileMap, repoTags.data[0].name);
    if (defaultFile) {
        cdnjsData.filename = defaultFile;
    }

    // Cleanup
    await fs.rmdir(tarPath, { recursive: true });

    return cdnjsData;
};

const main = async () => {
    const [, , rawName] = process.argv;

    // Validate
    if (!rawName) {
        console.error(chalk.red('Usage: node index.js <cdnjsLibraryName>'));
        return;
    }

    // Get auto-update method
    const updateMethod = await updateChoice();
    let cdnjsData;
    switch (updateMethod) {
        case 1:
            cdnjsData = await npm({ name: rawName });
            break;

        case 2:
            cdnjsData = await github({ name: rawName });
            break;
    }

    // Final steps
    if (!cdnjsData) return;

    // Get PR resolves
    const resolves = await input(chalk.cyan.bold(`Issue this PR resolves (blank to skip): `));

    // Output
    try {
        console.log('\n\nAttempting to automatically create PR...');
        const pr = await createPR(cdnjsData, resolves ? `Resolves ${resolves}.` : '');
        console.log(chalk.green.bold(`\n\nCreated automatic PR: ${pr.data.html_url}`));
    } catch (e) {
        console.error(chalk.red(`\n\nFailed to create automatic PR`));
        console.error(e);
        console.error(e.message);
        console.error(e.status);
        console.log(chalk.green.bold(`\n\nCreate new file on cdnjs/packages: packages/${cdnjsData.name.slice(0, 1).toLowerCase()}/${cdnjsData.name}.json`));
        console.log(chalk.green(`${JSON.stringify(cdnjsData, null, 2)}`));
    }
};

main();
