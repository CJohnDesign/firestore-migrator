#!/usr/bin/env node

import * as admin from 'firebase-admin';
import * as fs from 'fs-extra';
import * as args from 'commander';
import * as csv from 'csvtojson';
import * as _ from 'lodash';
import { processFile as processXlsx } from 'excel-as-json';

let fileValue, collValue;

const description = [
    'Imports JSON, CSV or XLSX data to a Firestore Collection.',
    'Supports nested sub-collections with an object key prefix, such as "collection:name".'
];

args
    .version('0.0.2')
    .arguments('<file> <collection>')
    .description(description.join("\n  "))
    .option('-i, --id [id]', 'Field to use for document ID')
    .option('-m, --merge', 'Merge Firestore documents where insert id exists')
    .option('-p, --subcollection-prefix [prefix]', 'Sub collection prefix', 'collection')
    .option('-c, --col-oriented', 'XLSX column orientation. Defaults is row orientation')
    .option('-o, --omit-empty-fields', 'XLSX omit empty fields')
    .option('-s, --sheet [#]', 'XLSX Sheet # to import', '1')
    .option('-l, --log', 'Output document insert paths')
    .action((file, coll) => {
        fileValue = file;
        collValue = coll;
    })
    .parse(process.argv);

if (typeof fileValue === 'undefined') {
    console.error('No file given!');
    args.outputHelp();
    process.exit(1);
}

if (typeof collValue === 'undefined') {
    console.error('No collection given!');
    args.outputHelp();
    process.exit(2);
}

// Firebase App Initialization
var serviceAccount = require("../credentials.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Main migration function

async function migrate() {
    try {
        const colPath = collValue;
        const file: string = fileValue;
    
        // Create a batch to run an atomic write
        const batch = db.batch();
    
        let data;
        if (file.endsWith(".json")) {
            data = await fs.readJSON(file);
        }

        else if (file.endsWith(".csv")) {
            data = await readCSV(file);
        }

        else if (file.endsWith(".xlsx")) {
            data = await readXLSX(file);
        }

        else {
            throw "Unknown file extension. Supports .json, .csv or .xlsx!";
        }
    
        
        const processCollection = (data: JSON, path: string) => {
            const mode = (data instanceof Array) ? 'array' : 'object';
            const colRef = db.collection(path);
            _.forEach(data, (item:object,id) => {
                // doc-id preference: object key, invoked --id option, auto-id
                id = (mode === 'object') ? id : (args.id && _.hasIn(item, args.id)) ? item[args.id].toString() : colRef.doc().id;
                
                // Look for and process sub-collections
                const subColKeys = Object.keys(item).filter(k => k.startsWith(args.subcollectionPrefix+':'));
                subColKeys.forEach((key:string) => {
                    const subPath = [path, id, key.slice(1 + args.subcollectionPrefix.length) ].join('/');
                    processCollection(item[key], subPath);
                    delete item[key];
                });
                
                // set document path/id and data
                const docRef = colRef.doc(id);
                batch.set(docRef, item, { merge: !!(args.merge) });

                // log if requested
                args.log && console.log(docRef.path);
            });
        }

        processCollection(data, colPath);
    
        // Commit the batch
        await batch.commit();
    
        console.log("Firestore updated. Migration was a success!");
    } catch (error) {
        console.log("Migration failed!", error);
    }
}

function readCSV(path): Promise<any> {
    return new Promise((resolve, reject) => {
        let lineCount = 0;

        csv()
            .fromFile(path)
            .on("json", data => {
                // fired on every row read
                lineCount++;
            })
            .on("end_parsed", data => {
                console.info(`CSV read complete. ${lineCount} rows parsed.`);
                resolve(data);
            })
            .on("error", err => reject(err));
    });
}

function readXLSX(path): Promise<any> {
    return new Promise((resolve, reject) => {
        const options = {
            sheet: args.sheet,
            isColOriented: args.colOriented ? true : false,
            omitEmtpyFields: args.omitEmptyFields ? true : false
        }
        console.log('Reading XLSX with options', options);
        processXlsx(path, null, options, (err,data) => {
            if (err) reject(err);
            console.info('XLSX read complete.');
            resolve(data);
        })
    });
}

// Run
migrate();
