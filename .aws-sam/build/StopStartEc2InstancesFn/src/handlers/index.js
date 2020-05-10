var AWS = require('aws-sdk');
var apiVersion = "2015-10-01";
var results = {};
var semaphore = { "describe": 0, "terminate": 0};	// A quick and CPU cheap way to enforce asynchronous signaling (essentially a Promise)
var shouldTerminateInstances = true; // false For testing purposes

/**
 * The "main" function which AWS Lambda executes.
 */
exports.handler = function(event, context) {
    console.log(event);

    semaphore.describe++;

    let region = process.env.AWS_REGION
    var ec2 = new AWS.EC2({region:region, apiVersion:apiVersion});
    var request = ec2.describeInstances({DryRun:false});

    console.log("----- Before Request -----");
    // On a successful describe, execute the following callback
    request.on("success", function(response) {
        var region = response.request.service.config.region;
        var data = response.data;
        console.log("region: " + region);
        console.log("data: " + JSON.stringify(data));
        var ids = [];
        for(var i = 0; i < data.Reservations.length; i++) {
            var Instances = data.Reservations[i].Instances;
            for(var j = 0; j < Instances.length; j++) {
                var instance = Instances[j];
                if(isBroker(instance))
                    ids.push(instance.InstanceId);
            }
        }
        announce(region, ids);

        // If some Instances have been identified, attempt to terminate
        if(ids.length > 0) {
            console.log("We have ["+ ids.length +"] broker instances");
            semaphore.terminate++;
            var ec2 = new AWS.EC2(response.request.service.config);
            
            var request = null;
            var reqData = { "DryRun":!shouldTerminateInstances, "InstanceIds":ids };
            let action = event.action
            
            if (action !== null && event.action == "start") {
                console.log("starting instances")
                request = ec2.startInstances(reqData);	// Defaulting to DryRun true when starting Instances
            } else {
                console.log("stopping instances")
                request = ec2.stopInstances(reqData);	// Defaulting to DryRun true when stopping Instances
            }
            
            // Callback for successful stop
            request.on("success", function(response) {
                var region = response.request.service.config.region;
                var body = JSON.stringify(response.data);
                results[region] = response.data;
                announce(region, body);
                console.log("Successfully stopped broker instances");
            });

            // Callback for error stop
            request.on("error", cbError);

            // Callback when terminating attempt has finished, successful or not -- decrement the terminate semaphore and check if finished
            request.on("complete", function() {
                semaphore.terminate--;
                if(describingDone() && terminatingDone()) {
                    context.succeed(results);
                }
            });

            request.send();	// Issue the stop/stop request

        }
    });

    // Callback for error describe
    request.on("error", cbError);

    // Callback when describing attempt has finished, successful or not -- decrement the describe semaphore and check if finished
    request.on("complete", function() {
        semaphore.describe--;
        if(describingDone() && terminatingDone()) {
            context.succeed(results);
        }
    });

    request.send();	// Issue the describe request
};

/**
 * A simple logging function used for printing to AWS Lambda logs.
 */
function announce(region, message) {
    if(region !== null) { d = "=========="; console.log(d + " " + region + " " + d); }
    console.log(message);
}
/**
 * Generic callback used for error responses.
 */
function cbError(error, response) {
    console.log("there was an error: " + error);
    results[response.request.service.config.region] = error;
    announce(response.request.service.config.region, JSON.stringify(error));
}
/**
 * Return true if all describing calls are finished, false otherwise.
 */
function describingDone() {
    if(isDone(semaphore.describe)) { return true; }
    return false;
}
/**
 * Return true if all terminating calls are finished, false otherwise.
 */
function terminatingDone() {
    if(isDone(semaphore.terminate)) { return true; }
    return false;
}
function isDone(counter) {
    return counter === 0;
}
/**
 * Return true if a given Instance is considered tagless, false otherwise.
 */
function isBroker(instance) {
    try {
        if(!instance.Tags || instance.Tags.length === 0) {
            console.error("Instance: [" + instance.InstanceId + "] doesn't have any tags.");
            return false; 
        }
        
        for(var j = 0; j < instance.Tags.length; j++) {
            if(instance.Tags[j].Key == "broker" && instance.Tags[j].Value === "igMarketsFx")
            console.log("Instance: [" + instance.InstanceId + "] has broker tag.");
            return true;
        }
    } catch(e) {}
    return false;
}