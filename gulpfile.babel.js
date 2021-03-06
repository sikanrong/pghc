import gulp from "gulp";
import Handlebars from "handlebars";
import * as fs from "fs"
import * as $package from "./package.json"
import path from "path";
import K8s from "kubernetes-client";
import uuidv1 from "uuid/v1";
import yaml from "js-yaml";

let client;
const k8sSpecs = {};

gulp.task("k8s-connect", async () => {
    client = new K8s.Client({ config: K8s.config.fromKubeconfig(), version: '1.10' });
    await client.loadSpec();

    await client.api.v1.namespaces.post({ body: yaml.safeLoad(fs.readFileSync(path.join(__dirname, 'kubernetes', 'pghc.namespace.spec.k8s.yaml')))}).catch(_e => {
        if(_e.code != 409){
            throw new Error(_e);
        }
    });
});

const loadConfig = async (endpoint, _s, _method) => {
    _method = _method || forceRecreate.bind(this);
    let _spec;
    if(typeof _s == 'string'){
        _spec = yaml.safeLoad(fs.readFileSync(_s));
    }else{
        _spec = _s;
    }

    let _res = await _method(endpoint, _spec).catch(_e => {
        throw new Error(_e);
    });

    console.log(_res);
};

const createOrUpdate = async (endpoint, payload) => {
    return await endpoint.post({body: payload}).catch(async _e => {
        if(_e.message.indexOf('already exists') >= 0){
            return await endpoint(payload.metadata.name).patch({body: payload}).catch(_e => {
                throw new Error (_e);
            });
        }else{
            throw new Error(_e);
        }
    })
};

const forceRecreate = async (endpoint, payload) => {
    await endpoint(payload.metadata.name).delete().catch(_e => {
        if(_e.code != 404){
            throw new Error(_e);
        }
    });
    const _res = await endpoint.post({body: payload}).catch(_e => {throw new Error(_e)});
    console.log(_res);
    return _res;
};

gulp.task("read-configs", async () => {
    //yaml.safeLoad(fs.readFileSync(path.join(__dirname, 'kubernetes', 'controllers', 'pghc-postgres-repl.statefulset.spec.k8s.yaml')));
    const readYaml = (_p, fname) => {
        return yaml.safeLoad(fs.readFileSync(path.join(_p, fname)));
    };

    const controllerDir = path.join(__dirname, 'kubernetes', 'controllers');
    const servicesDir = path.join(__dirname, 'kubernetes', 'services');

    fs.readdirSync(controllerDir).forEach(_f => {
        k8sSpecs[_f] = readYaml(controllerDir, _f);
    });

    fs.readdirSync(servicesDir).forEach(_f => {
        k8sSpecs[_f] = readYaml(servicesDir, _f);
    });

    if($package.pghc.num_total_pg_nodes){
        console.warn('OVERRIDING kubernetes/controllers replicas with values configured from package.json:');

        if(($package.pghc.num_total_pg_nodes % $package.pghc.num_bdr_groups) != 0){
            throw new Error("package.json: pghc.num_total_pg_nodes must be a perfect multiple of the integer defined by pghc.num_bdr_groups");
        }

        const backend_nodes = $package.pghc.num_total_pg_nodes - $package.pghc.num_bdr_groups;
        const slave_nodes = backend_nodes;
        const master_nodes = $package.pghc.num_bdr_groups;

        console.warn(`Configuring ${backend_nodes} app-backend nodes...`);
        console.warn(`Configuring ${slave_nodes} pg-slave nodes...`);
        console.warn(`Configuring ${master_nodes} pg-master nodes...`);

        k8sSpecs['pghc-backend.statefulset.spec.k8s.yaml'].spec.replicas = backend_nodes;
        k8sSpecs['pghc-postgres-repl.statefulset.spec.k8s.yaml'].spec.replicas = $package.pghc.num_total_pg_nodes;
    }

});

gulp.task("k8s-configmaps", ["k8s-connect", "read-configs"], async () => {

    let conf_payload = {
        kind: "ConfigMap",
        metadata: {
            name: "pg-conf"
        },
        data: {}
    };

    //Get number of replicas from the configuration
    const pgReplSet = k8sSpecs['pghc-postgres-repl.statefulset.spec.k8s.yaml'];
    const zkReplSet = k8sSpecs['pghc-zookeeper.statefulset.spec.k8s.yaml'];
    const zk_node_set = Array.apply(null, {length: zkReplSet.spec.replicas}).map(Number.call, Number);

    //Copy Postgres conf to Kubernetes ConfigMap
    const pgHbaConf = `
      host all all 0.0.0.0/0 trust
      host replication all 0.0.0.0/0 trust
      
      local all all trust
      local replication all trust
    `.replace(/^\s+/gm, '').trim();

    conf_payload.data["pg_hba.conf"] = pgHbaConf;

    const slave_indices = Array.from(Array(pgReplSet.spec.replicas).keys());

    const nodesPerDataCenter = parseInt( pgReplSet.spec.replicas / $package.pghc.num_bdr_groups );

    const pgReplNames = slave_indices.filter(_i => {
        if ((_i % nodesPerDataCenter) == 0){
            return false;
        }else{
            return true;
        }
    }).map(_i => {
        return `${pgReplSet.metadata.name}-${_i}`
    });

    let template;

    //Write PostgreSQL WAL-replica (slave) node configuration files.

    slave_indices.forEach(_i => {
        let _master_idx = (parseInt( _i / nodesPerDataCenter ) * nodesPerDataCenter);
        const wal_path = `${$package.pghc.wal_archive_path}/${_master_idx}`;


        if(_i == _master_idx){
            let template = Handlebars.compile(fs.readFileSync('./remote_cfg/postgresql.master.conf', 'utf8'), {noEscape: true});
            const pgMasterConf = template({
                wal_archive_path: wal_path,
                synchronous_standby_names: pgReplNames.join(', ')
            });

            template = Handlebars.compile(fs.readFileSync('./remote_cfg/recovery.master.conf', 'utf8'), {noEscape: true});
            const pgMasterRecovery = template({ wal_archive_path: wal_path });

            conf_payload.data[`recovery.master${_i}.conf`] = pgMasterRecovery;
            conf_payload.data[`postgresql.master${_i}.conf`] = pgMasterConf;
        }else{
            template = Handlebars.compile(fs.readFileSync('./remote_cfg/recovery.slave.conf', 'utf8'), {noEscape: true});
            const pgSlaveRecovery = template({
                wal_archive_path: wal_path,
                master_host: `${pgReplSet.metadata.name}-${_master_idx}.pghc-postgres-dns.pghc.svc.cluster.local`,
                application_name: `${pgReplSet.metadata.name}-${_i}`
            });

            conf_payload.data[`slave${_i}.master`] = new String(_master_idx);
            conf_payload.data[`recovery.slave${_i}.conf`] = pgSlaveRecovery;
            conf_payload.data[`postgresql.slave${_i}.conf`] = fs.readFileSync('./remote_cfg/postgresql.slave.conf', 'utf8');
        }
    });

    await forceRecreate(client.api.v1.namespaces('pghc').configmaps, conf_payload);

    //Write Zookeeper configuration files
    const conf = fs.readFileSync("remote_cfg/zoo.cfg", "utf8");
    template = Handlebars.compile(conf, {noEscape: true});

    const zkConf = template({
        zk_servers: zk_node_set.map(_i => {
            return `server.${(_i + 1).toString()}=pghc-zookeeper-${_i}.pghc-zookeeper-dns.pghc.svc.cluster.local:2888:3888`;
        }).join("\n")
    });

    conf_payload = {
        kind: "ConfigMap",
        metadata: {
            name: "zk-conf"
        },
        data: {
            "zoo.cfg": zkConf
        }
    };

    zk_node_set.forEach(_i => {
        conf_payload.data[`zk_myid.${_i}`] = (_i + 1).toString();
    });

    await forceRecreate(client.api.v1.namespaces('pghc').configmaps, conf_payload);
});

const deployPostgresNodes = async () => {
    await loadConfig(client.apis.apps.v1.namespaces('pghc').statefulsets, k8sSpecs['pghc-postgres-repl.statefulset.spec.k8s.yaml']);
    await loadConfig(client.api.v1.namespaces('pghc').services, k8sSpecs['pghc-postgres.dns.spec.k8s.yaml']);
};

const deployZookeeper = async() => {
    await loadConfig(client.apis.apps.v1.namespaces('pghc').statefulsets, k8sSpecs['pghc-zookeeper.statefulset.spec.k8s.yaml']);
    await loadConfig(client.api.v1.namespaces('pghc').services, k8sSpecs['pghc-zookeeper.dns.spec.k8s.yaml']);
};

const deployFrontend = async() => {
    await loadConfig(client.apis.apps.v1.namespaces('pghc').statefulsets, k8sSpecs['pghc-backend.statefulset.spec.k8s.yaml']);
    await loadConfig(client.api.v1.namespaces('pghc').services, k8sSpecs['pghc-backend.loadbalancer.spec.k8s.yaml']);
    await loadConfig(client.api.v1.namespaces('pghc').services, k8sSpecs['pghc-backend.dns.spec.k8s.yaml']);

    await loadConfig(client.api.extensions.v1beta1.namespaces('pghc').ingresses, k8sSpecs['pghc-ingress.controller.spec.k8s.yaml']);
};

const deploy_deps = ["k8s-connect", "k8s-configmaps", "read-configs"];

gulp.task("k8s-deploy-backend", deploy_deps, deployFrontend.bind(this));
gulp.task("k8s-deploy-postgres", deploy_deps, deployPostgresNodes.bind(this));
gulp.task("k8s-deploy-zookeeper", deploy_deps, deployZookeeper.bind(this));

gulp.task("k8s-deploy", deploy_deps, async () => {
    await deployPostgresNodes();
    await deployZookeeper();
    await deployFrontend();
});