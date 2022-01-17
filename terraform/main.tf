terraform {
  backend "s3" {
    bucket = "mikec-prod-tf-states"
    key    = "notion-feeder"
    region = "us-west-2"
  }
}
provider "aws" {
  region = "us-west-2"
}

#####
# VPC and subnets
# TODO those should live in an infra tf project
#####
data "aws_vpc" "default" {
  default = true
}

# resource aws_subnet "main" {
# }

data "aws_subnet_ids" "prod1" {
  vpc_id = data.aws_vpc.default.id
}

# module "alb" {
#   source  = "umotif-public/alb/aws"
#   version = "~> 2.0"

#   name_prefix        = "alb-example"
#   load_balancer_type = "application"
#   internal           = false
#   vpc_id             = data.aws_vpc.default.id
#   subnets            = data.aws_subnet_ids.all.ids
# }

# resource "aws_lb_listener" "alb_80" {
#   load_balancer_arn = module.alb.arn
#   port              = "80"
#   protocol          = "HTTP"

#   default_action {
#     type             = "forward"
#     target_group_arn = module.fargate.target_group_arn[0]
#   }
# }

# #####
# # Security Group Config
# #####
# resource "aws_security_group_rule" "alb_ingress_80" {
#   security_group_id = module.alb.security_group_id
#   type              = "ingress"
#   protocol          = "tcp"
#   from_port         = 80
#   to_port           = 80
#   cidr_blocks       = ["0.0.0.0/0"]
#   ipv6_cidr_blocks  = ["::/0"]
# }

# resource "aws_security_group_rule" "task_ingress_80" {
#   security_group_id        = module.fargate.service_sg_id
#   type                     = "ingress"
#   protocol                 = "tcp"
#   from_port                = 80
#   to_port                  = 80
#   source_security_group_id = module.alb.security_group_id
# }

#####
# ECS cluster and fargate
#####

resource "aws_ecr_repository" "notion-feeder" {
  name                 = "notion-feeder"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = false
  }
}

resource "aws_ecs_cluster" "default" {
  name               = "prod-cluster"
  capacity_providers = [
    "FARGATE_SPOT",
    "FARGATE"
  ]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
  }
}

module "ecs-fargate" {
  source = "umotif-public/ecs-fargate/aws"
  version = "~> 6.1.0"

  name_prefix        = "notion-feeder"
  vpc_id             = data.aws_vpc.default.id
  private_subnet_ids = data.aws_subnet_ids.prod1.ids

  cluster_id         = aws_ecs_cluster.default.id

  task_container_image   = "865152046867.dkr.ecr.us-west-2.amazonaws.com/notion-feeder:latest"
  task_definition_cpu    = 256
  task_definition_memory = 512

  task_container_port             = 80
  task_container_assign_public_ip = false

  capacity_provider_strategy = [
    {
      capacity_provider = "FARGATE_SPOT"
      weight = 100
    }
  ]

  health_check  = {
    port = "traffic_port"
    path = "/"
  }

  health_check_grace_period_seconds = null

  tags = {
    Environment = "prod"
    Project = "notion-feeder"
  }
}
