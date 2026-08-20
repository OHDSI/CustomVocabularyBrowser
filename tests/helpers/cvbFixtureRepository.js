import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const CORE_FILE_NAMES = Object.freeze([
  "concept_delta.csv",
  "concept_synonym_delta.csv",
  "concept_relationship_delta.csv",
]);

const FILE_SETS = Object.freeze({
  "valid-source": Object.freeze({
    "ALPHA/Ontology/concept_delta.csv": csv([
      "concept_id,concept_name,domain_id,vocabulary_id,concept_class_id,standard_concept,concept_code,valid_start_date,valid_end_date,invalid_reason",
      '1000000001,"  Alpha, ""quoted"" concept  ",Observation,ALPHA_VOC,Class A,,0007,2020-01-01,2099-12-31,',
      '1000000002,"Second concept",Measurement,SECOND_VOC,Class B,S,CODE-B,20200102,20991231,',
    ]),
    "ALPHA/Ontology/concept_synonym_delta.csv": csv([
      "concept_id,concept_synonym_name,language_concept_id",
      '1000000001,"Alpha alias, primary",4180186',
      "1000000002,Second alias,4180186",
      "9999999999,External alias,4180186",
    ]),
    "ALPHA/Ontology/concept_relationship_delta.csv": csv([
      "concept_id_1,concept_id_2,relationship_id,valid_start_date,valid_end_date,invalid_reason",
      "1000000001,1000000002,Maps to,2020-01-01,2099-12-31,",
      "9999999999,1000000001,Mapped from,2020-01-01,2099-12-31,",
      "1000000001,8888888888,Maps to,2020-01-01,2099-12-31,",
      "7777777777,8888888888,Is a,2020-01-01,2099-12-31,",
    ]),
    "ALPHA/Ontology/concept_ancestor_delta.csv": csv([
      "ancestor_concept_id,descendant_concept_id,min_levels_of_separation",
      "1000000001,1000000002,1",
    ]),
    "ALPHA/Ontology/vocabulary_delta.csv": csv([
      "vocabulary_id,vocabulary_name,vocabulary_reference,vocabulary_version,vocabulary_concept_id",
      "ALPHA_VOC,Alpha vocabulary,https://example.test/alpha,1.0,9000000001",
      "SECOND_VOC,Second vocabulary,https://example.test/second,2.0,9000000002",
    ]),
    "BETA/concept_delta.csv": csv([
      "concept_id,concept_name,domain_id,vocabulary_id,concept_class_id,standard_concept,concept_code,valid_start_date,valid_end_date,invalid_reason",
      "2000000001,Beta concept,Observation,INTERNAL_BETA,Source Concept,,B-001,2021-01-01,2099-12-31,",
    ]),
    "BETA/concept_synonym_delta.csv": csv([
      "concept_id,concept_synonym_name,language_concept_id",
      "2000000001,Beta alias,4180186",
    ]),
    "BETA/concept_relationship_delta.csv": csv([
      "concept_id_1,concept_id_2,relationship_id,valid_start_date,valid_end_date,invalid_reason",
      "2000000001,3000000001,Maps to,2021-01-01,2099-12-31,",
    ]),
    "CONCEPT_ONLY/Ontology/concept_delta.csv": csv([
      "concept_id,concept_name,domain_id,vocabulary_id,concept_class_id,standard_concept,concept_code,valid_start_date,valid_end_date,invalid_reason",
      "3000000001,Incomplete concept,Observation,INCOMPLETE,Source Concept,,I-001,2021-01-01,2099-12-31,",
    ]),
  }),
  "invalid-core-source": Object.freeze({
    "BROKEN/Ontology/concept_delta.csv": csv([
      "concept_id,concept_name,domain_id,vocabulary_id,concept_class_id,standard_concept,concept_code,valid_start_date,valid_end_date,invalid_reason",
      "6000000001,Broken concept,Observation,BROKEN_VOC,Source Concept,X,B-001,2022-01-01,2099-12-31,",
    ]),
    "BROKEN/Ontology/concept_synonym_delta.csv": csv([
      "concept_id,concept_synonym_name,language_concept_id",
      "6000000001,Broken alias,4180186",
    ]),
    "BROKEN/Ontology/concept_relationship_delta.csv": csv([
      "concept_id_1,concept_id_2,relationship_id,valid_start_date,valid_end_date,invalid_reason",
      "6000000001,123456,Maps to,2022-01-01,2099-12-31,",
    ]),
    "VALID/Ontology/concept_delta.csv": csv([
      "concept_id,concept_name,domain_id,vocabulary_id,concept_class_id,standard_concept,concept_code,valid_start_date,valid_end_date,invalid_reason",
      "5000000001,Valid concept,Observation,VALID_VOC,Source Concept,,V-001,2022-01-01,2099-12-31,",
    ]),
    "VALID/Ontology/concept_synonym_delta.csv": csv([
      "concept_id,concept_synonym_name,language_concept_id",
      "5000000001,Valid alias,4180186",
    ]),
    "VALID/Ontology/concept_relationship_delta.csv": csv([
      "concept_id_1,concept_id_2,relationship_id,valid_start_date,valid_end_date,invalid_reason",
      "5000000001,123456,Maps to,2022-01-01,2099-12-31,",
    ]),
  }),
});

const EMPTY_DIRECTORIES = Object.freeze({
  "valid-source": Object.freeze(["HPO"]),
  "invalid-core-source": Object.freeze([]),
});

export function validSourceContent(repositoryPath) {
  const content = FILE_SETS["valid-source"][repositoryPath];
  if (content === undefined) throw new Error("Unknown synthetic fixture path: " + repositoryPath);
  return content;
}

export async function materializeCvbFixture(t, name) {
  const files = FILE_SETS[name];
  if (!files) throw new Error("Unknown synthetic fixture set: " + name);

  const sourceRoot = await mkdtemp(path.join(tmpdir(), "cvb-" + name + "-"));
  t.after(async () => {
    await rm(sourceRoot, { recursive: true, force: true });
  });

  await Promise.all([
    ...Object.entries(files).map(async ([repositoryPath, content]) => {
      const filename = path.join(sourceRoot, ...repositoryPath.split("/"));
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, content, "utf8");
    }),
    ...EMPTY_DIRECTORIES[name].map((repositoryPath) => (
      mkdir(path.join(sourceRoot, ...repositoryPath.split("/")), { recursive: true })
    )),
  ]);

  return sourceRoot;
}

function csv(lines) {
  return lines.join("\n") + "\n";
}
