/*
cacophony-api: The Cacophony Project API server
Copyright (C) 2018  The Cacophony Project
This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.
You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

const bcrypt = require("bcrypt");
const format = require("util").format;
const Sequelize = require("sequelize");
const ClientError = require("../api/customErrors").ClientError;
const { AuthorizationError } = require("../api/customErrors");

const Op = Sequelize.Op;

module.exports = function(sequelize, DataTypes) {
  const name = "Device";

  const attributes = {
    devicename: {
      type: DataTypes.STRING,
      unique: true
    },
    password: {
      type: DataTypes.STRING,
      allowNull: false
    },
    location: {
      type: DataTypes.STRING
    },
    lastConnectionTime: {
      type: DataTypes.DATE
    },
    public: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    currentConfig: {
      type: DataTypes.JSONB
    },
    newConfig: {
      type: DataTypes.JSONB
    },
    saltId: {
      type: DataTypes.INTEGER
    },
    active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      allowNull: false
    }
  };

  const options = {
    hooks: {
      afterValidate: afterValidate
    }
  };

  const Device = sequelize.define(name, attributes, options);

  //---------------
  // CLASS METHODS
  //---------------
  const models = sequelize.models;

  Device.addAssociations = function(models) {
    models.Device.hasMany(models.Recording);
    models.Device.hasMany(models.Event);
    models.Device.belongsToMany(models.User, { through: models.DeviceUsers });
    models.Device.belongsTo(models.Schedule);
    models.Device.belongsTo(models.Group);
  };

  /**
   * Adds/update a user to a Device, if the given user has permission to do so.
   * The authenticated user must either be admin of the group that the device
   * belongs to, an admin of that device, or have global write permission.
   */
  Device.addUserToDevice = async function(authUser, device, userToAdd, admin) {
    if (device == null || userToAdd == null) {
      return false;
    }
    if (!(await device.userPermissions(authUser)).canAddUsers) {
      throw new AuthorizationError(
        "User is not a group, device, or global admin so cannot add users to this device"
      );
    }

    // Get association if already there and update it.
    const deviceUser = await models.DeviceUsers.findOne({
      where: {
        DeviceId: device.id,
        UserId: userToAdd.id
      }
    });
    if (deviceUser != null) {
      deviceUser.admin = admin; // Update admin value.
      await deviceUser.save();
      return true;
    }

    await device.addUser(userToAdd.id, { through: { admin: admin } });
    return true;
  };

  /**
   * Removes a user from a Device, if the given user has permission to do so.
   * The user must be a group or device admin, or have global write permission to do this. .
   */
  Device.removeUserFromDevice = async function(authUser, device, userToRemove) {
    if (device == null || userToRemove == null) {
      return false;
    }
    if (!(await device.userPermissions(authUser)).canRemoveUsers) {
      throw new AuthorizationError(
        "User is not a group, device, or global admin so cannot remove users from this device"
      );
    }

    // Check that association is there to delete.
    const deviceUsers = await models.DeviceUsers.findAll({
      where: {
        DeviceId: device.id,
        UserId: userToRemove.id
      }
    });
    for (const i in deviceUsers) {
      await deviceUsers[i].destroy();
    }
    return true;
  };

  Device.onlyUsersDevicesMatching = async function(
    user,
    conditions = null,
    includeData = null
  ) {
    // Return all devices if user has global write/read permission.
    if (user.hasGlobalRead()) {
      return this.findAndCountAll({
        where: conditions,
        attributes: ["devicename", "id", "GroupId", "active"],
        include: includeData,
        order: ["devicename"]
      });
    }

    const whereQuery = await addUserAccessQuery(user, conditions);

    return this.findAndCountAll({
      where: whereQuery,
      attributes: ["devicename", "id", "active"],
      order: ["devicename"],
      include: includeData
    });
  };

  Device.allForUser = async function(user) {
    const includeData = [
      {
        model: models.User,
        attributes: ["id", "username"]
      }
    ];

    return this.onlyUsersDevicesMatching(user, null, includeData);
  };

  Device.newUserPermissions = function(enabled) {
    return {
      canListUsers: enabled,
      canAddUsers: enabled,
      canRemoveUsers: enabled
    };
  };

  Device.freeDevicename = async function(devicename) {
    const device = await this.findOne({ where: { devicename: devicename } });
    if (device != null) {
      return false;
    }
    return true;
  };

  Device.getFromId = async function(id) {
    return await this.findById(id);
  };

  Device.findDevice = async function(
    deviceID,
    deviceName,
    groupName,
    password
  ) {
    // attempts to find a unique device by groupname, then deviceid (devicename if int),
    // then devicename, finally password
    let model = null;
    if (deviceID && deviceID > 0) {
      model = this.findByPk(deviceID);
    } else if (groupName) {
      model = await this.getFromNameAndGroup(deviceName, groupName);
    } else {
      const models = await this.allWithName(deviceName);
      //check for devicename being id
      deviceID = parseExactInt(deviceName);
      if (deviceID) {
        model = this.findByPk(deviceID);
      }

      //check for distinct name
      if (model == null) {
        if (models.length == 1) {
          model = models[0];
        }
      }

      //check for device match from password
      if (model == null && password) {
        model = await this.wherePasswordMatches(models, password);
      }
    }
    return model;
  };

  Device.wherePasswordMatches = async function(devices, password) {
    // checks if there is a unique devicename and password match, else returns null
    const validDevices = [];
    let passwordMatch = false;
    for (let i = 0; i < devices.length; i++) {
      passwordMatch = await devices[i].comparePassword(password);
      if (passwordMatch) {
        validDevices.push(devices[i]);
      }
    }
    if (validDevices.length == 1) {
      return validDevices[0];
    } else {
      if (validDevices.length > 1) {
        throw new Error(
          format("Multiple devices match %s and supplied password", name)
        );
      }
      return null;
    }
  };

  Device.getFromNameAndPassword = async function(name, password) {
    const devices = await this.allWithName(name);
    return this.wherePasswordMatches(devices, password);
  };

  Device.allWithName = async function(name) {
    return await this.findAll({ where: { devicename: name } });
  };

  Device.getFromNameAndGroup = async function(name, groupName) {
    return await this.findOne({
      where: { devicename: name },
      include: [
        {
          model: models.Group,
          where: { groupname: groupName }
        }
      ]
    });
  };

  /**
   * finds devices that match device array and groups array with supplied operator (or by default)
   */
  Device.queryDevices = async function(authUser, devices, groups, operator) {
    let whereQuery;
    let nameMatches;
    if (!operator) {
      operator = Op.or;
    }

    if (devices) {
      const fullNames = devices.filter(device => {
        return device.devicename.length > 0 && device.groupname.length > 0;
      });
      if (fullNames.length > 0) {
        const groupDevices = fullNames.map(device =>
          [device.groupname, device.devicename].join(":")
        );
        whereQuery = Sequelize.where(
          Sequelize.fn(
            "concat",
            Sequelize.col("Group.groupname"),
            ":",
            Sequelize.col("devicename")
          ),
          { [Op.in]: groupDevices }
        );
      }

      const deviceNames = devices.filter(device => {
        return device.devicename.length > 0 && device.groupname.length == 0;
      });
      if (deviceNames.length > 0) {
        const names = deviceNames.map(device => device.devicename);
        let nameQuery = Sequelize.where(Sequelize.col("devicename"), {
          [Op.in]: names
        });
        nameQuery = await addUserAccessQuery(authUser, nameQuery);
        nameMatches = await this.findAll({
          where: nameQuery,
          include: [
            {
              model: models.Group,
              as: "Group",
              attributes: ["groupname"]
            }
          ],
          raw: true,
          attributes: ["Group.groupname", "devicename", "id", "saltId"]
        });
      }
    }

    if (groups) {
      const groupQuery = Sequelize.where(Sequelize.col("Group.groupname"), {
        [Op.in]: groups
      });
      if (devices) {
        whereQuery = { [operator]: [whereQuery, groupQuery] };
      } else {
        whereQuery = groupQuery;
      }
    }
    const matches = {};
    if (whereQuery) {
      whereQuery = await addUserAccessQuery(authUser, whereQuery);
      matches.devices = await this.findAll({
        where: whereQuery,
        include: [
          {
            model: models.Group,
            as: "Group",
            attributes: ["groupname"]
          }
        ],
        raw: true,
        attributes: ["Group.groupname", "devicename", "id", "saltId"]
      });
    }
    if (nameMatches) {
      matches.nameMatches = nameMatches;
    }
    return matches;
  };

  // Fields that are directly settable by the API.
  Device.apiSettableFields = ["location", "newConfig"];

  //------------------
  // INSTANCE METHODS
  //------------------

  Device.prototype.userPermissions = async function(user) {
    if (user.hasGlobalWrite()) {
      return Device.newUserPermissions(true);
    }

    const isGroupAdmin = await models.GroupUsers.isAdmin(this.GroupId, user.id);
    const isDeviceAdmin = await models.DeviceUsers.isAdmin(this.id, user.id);
    return Device.newUserPermissions(isGroupAdmin || isDeviceAdmin);
  };

  Device.prototype.getJwtDataValues = function() {
    return {
      id: this.getDataValue("id"),
      _type: "device"
    };
  };

  Device.prototype.comparePassword = function(password) {
    const device = this;
    return new Promise(function(resolve, reject) {
      bcrypt.compare(password, device.password, function(err, isMatch) {
        if (err) {
          reject(err);
        } else {
          resolve(isMatch);
        }
      });
    });
  };

  // Returns users that have access to this device either via group
  // membership or direct assignment. By default, only "safe" user
  // attributes are returned.
  Device.prototype.users = async function(
    authUser,
    attrs = ["id", "username", "email"]
  ) {
    if (!(await this.userPermissions(authUser)).canListUsers) {
      return [];
    }

    const device_users = await this.getUsers({ attributes: attrs });
    const group = await models.Group.getFromId(this.GroupId);
    const group_users = await group.getUsers({ attributes: attrs });

    return device_users.concat(group_users);
  };

  // Will register as a new device
  Device.prototype.reregister = async function(newName, newGroup, newPassword) {
    let newDevice;
    await sequelize.transaction(
      {
        isolationLevel: Sequelize.Transaction.ISOLATION_LEVELS.SERIALIZABLE
      },
      async t => {
        const conflictingDevice = await Device.findOne({
          where: {
            devicename: newName,
            GroupId: newGroup.id
          },
          transaction: t
        });

        if (conflictingDevice != null) {
          throw new ClientError(
            "already a device in group '" +
              newGroup.groupname +
              "' with the name '" +
              newName +
              "'"
          );
        }

        await Device.update(
          {
            active: false
          },
          {
            where: { saltId: this.saltId },
            transaction: t
          }
        );

        newDevice = await models.Device.create(
          {
            devicename: newName,
            GroupId: newGroup.id,
            password: newPassword,
            saltId: this.saltId
          },
          {
            transaction: t
          }
        );
      }
    );
    return newDevice;
  };

  return Device;
};

/**
*
filters the supplied query by devices and groups authUser is authorized to access
*/
async function addUserAccessQuery(authUser, whereQuery) {
  if (authUser.hasGlobalRead()) {
    return whereQuery;
  }

  const deviceIds = await authUser.getDeviceIds();
  const userGroupIds = await authUser.getGroupsIds();

  const accessQuery = {
    [Op.and]: [
      {
        [Op.or]: [
          { GroupId: { [Op.in]: userGroupIds } },
          { id: { [Op.in]: deviceIds } }
        ]
      },
      whereQuery
    ]
  };

  return accessQuery;
}

function parseExactInt(value) {
  const iValue = parseInt(value);
  if (value === iValue.toString()) {
    return Number(iValue);
  } else {
    return null;
  }
}

/********************/
/* Validation methods */
/********************/

function afterValidate(device) {
  if (device.password !== undefined) {
    // TODO Make the password be hashed when the device password is set not in the validation.
    // TODO or make a custom validation for the password.
    return new Promise(function(resolve, reject) {
      bcrypt.hash(device.password, 10, function(err, hash) {
        if (err) {
          reject(err);
        } else {
          device.password = hash;
          resolve();
        }
      });
    });
  }
}
