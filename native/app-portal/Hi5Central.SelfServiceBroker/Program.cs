using Hi5Central.SelfServiceBroker;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

await Host.CreateDefaultBuilder(args)
    .UseWindowsService(options => options.ServiceName = "Hi5CentralSelfServiceBroker")
    .ConfigureServices(services => services.AddHostedService<BrokerService>())
    .Build()
    .RunAsync();
